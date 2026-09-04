// pi-antigravity-bridge - extension entry point.
//
// Registers Gemini (via the agy CLI) as a pi model provider so it shows up in
// the /model picker as antigravity/gemini-*. When selected, pi routes each turn
// through streamSimple, which feeds the persistent stream-json driver process
// and streams the agent text back into pi's TUI.
//
// Architectural wall (cannot be worked around - see PLAN.md):
//   agy runs its OWN closed tool loop against --add-dir. pi's read/write/edit/
//   bash tools never fire. Tool activity is surfaced as thinking events
//   ("[agy tool: editing foo.ts]") for visibility, but the edits already landed
//   on disk and pi's inline diff review does not engage.
//
// /agy command: full runtime config surface (engine, mode, permissions,
// bridge tools, model, thinking, digest, system prompt, acp binary) plus
// doctor, auth, patch-cleanup, and session clear. Config persists to
// ~/.pi/agent/antigravity-bridge/config.json so toggles survive restarts.

import os from "node:os";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	SettingsList,
	Text,
	type SettingItem,
} from "@earendil-works/pi-tui";
import {
	entriesFromRaw,
	FALLBACK_MODELS,
	loadModelCatalogRaw,
	toPiModel,
	type AgyModelEntry,
} from "../src/models.js";
import { SessionStore } from "../src/sessions.js";
import { ToolRoundTrips, WrapperReplay, createStreamSimple } from "../src/provider.js";
import { AgyDriver } from "../src/driver.js";
import { AcpDriver } from "../src/acp/driver.js";
import { setupAuthUrlCapture } from "../src/acp/browser-capture.js";
import { ensureAcpReady, inspectAcpSetup } from "../src/acp/setup.js";
import type { TurnDriver } from "../src/driver-types.js";
import { CONFIG_PATH, loadConfig, saveConfig, type AgyMode, type BridgeTools, type Engine, type ThinkingTier } from "../src/config.js";
import { registerAskAntigravityTool, toolModelsFromRaw } from "../src/ask-tool.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import {
	ACTIVATE_SKILL_TOOL_NAME,
	activateSkillSchema,
	catalogSummary,
	findSkillByName,
	readSkillBody,
	scanSkills,
	type SkillLite,
} from "../src/skills.js";
import { mapAgyToolToNative } from "../src/native-tools.js";
import { Type } from "typebox";
import { patchStatus, restorePatch } from "../src/patch-cleanup.js";

// Last UI seen (session_start / /agy commands). The ACP login URL arrives
// via the driver log sink, which has no command context; the stash lets that
// sink toast instead of only logging to stderr. Module scope: both the
// default export (session_start, log sink) and registerAgyCommand assign it.
let activeUi: ExtensionUIContext | null = null;

function resolveAgyBinary(): string {
	return process.env.AGY_BIN || "agy";
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// Claim the AskAntigravity tool for this process. pi-ask-antigravity (if also
	// installed) checks this in-process flag OR the bridge's package.json on disk
	// and defers. See that extension's isBridgeInstalled().
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-antigravity-bridge:active")] = true;

	const binary = resolveAgyBinary();

	// Discover once at load. Failure is non-fatal: FALLBACK_MODELS keeps the
	// picker populated so the user gets a clear runtime error from agy rather
	// than an empty model list. /reload re-runs this and refreshes after an
	// `agy update`.
	// loadModelCatalogRaw serves a short-TTL cache (~/.pi/agent/antigravity-bridge/
	// models-cache.json) so reloads are instant and only re-spawn in the
	// background when stale. Derive both catalogs from the same raw text
	// (provider's slugified Gemini entries + the tool's family/version/tier
	// entries).
	const raw = await loadModelCatalogRaw(binary);
	const discovered = entriesFromRaw(raw);
	const toolModels = toolModelsFromRaw(raw);
	const usingFallback = discovered.length === 0;
	const entries: AgyModelEntry[] = usingFallback ? FALLBACK_MODELS : discovered;
	// Engine latched at load: /agy engine takes effect on the next pi start
	// (documented). Everything below resolves from THIS value - per-call
	// config reads would let a mid-session flip leave ToolRoundTrips,
	// kickIdle, and reentry pointing at the other engine (round-7 finding).
	const engine: Engine = loadConfig().engine;
	// Engine switching requires a restart, so the catalog-time engine read is
	// authoritative for input advertising: image attach rides only when turns
	// will run on the ACP engine (the legacy CLI prompt is text-only).
	const modelInput: Array<"text" | "image"> = engine === "acp" ? ["text", "image"] : ["text"];
	const models = entries.map((e) => toPiModel(e, modelInput));

	const store = new SessionStore();
	// MCP bridge handle, declared early: the ACP engine reads the bridge port
	// at session/new / session/load time.
	let mcpHandle: McpServerHandle | null = null;
	// ACP self-heal runs once per process (session_start re-fires on /reload;
	// a ready setup is two file stats, so re-running is harmless anyway).
	let acpSelfHealRan = false;
	// OAuth URL capture: the server hands the login URL only to the
	// browser-open call (nothing on stdio), so a BROWSER wrapper records it
	// and the driver logs it as "auth-url". Local users keep the automatic
	// browser open; over SSH the URL surfaces for copy-paste with the
	// port-forward command.
	const authCapture = setupAuthUrlCapture();
	if (!authCapture && process.platform !== "win32") {
		// Rare (unwritable data dir). Surfacing the diagnostic: without it,
		// login URLs would silently stop appearing on headless boxes.
		console.error("[antigravity-bridge] OAuth URL capture unavailable; login URL surfacing is off (setup failed).");
	}
	// Two turn engines behind one contract (plan §9): stream-json (tested
	// default) and the official ACP server (opt-in via config.engine, off by
	// default). Neither spawns anything until its first turn.
	// ACP log routing: only genuine failures reach stderr. Routine lifecycle
	// (driver-created, spawn, session-new, ...) stays in the driver's
	// #lifecycle ring buffer, visible via /agy doctor. An unfiltered sink fired
	// console.error at extension load ("driver-created"), before any UI exists,
	// and leaked raw driver lines into the terminal on every startup.
	const acpFailures = new Set([
		"start-failed", "spawn-error", "parse-error", "write-failed",
		"mode-apply-failed", "timeout", "stall", "auth-required",
		"session-load-failed-creating-fresh", "connection-exited", "cancel-failed",
		"unsupported-server-request",
	]);
	const legacyDriver = new AgyDriver();
	const acpDriver = new AcpDriver({
		// Resolved per connection: the setup flow can install the binary and
		// update acp.bin mid-session; the next turn picks it up (no restart).
		bin: () => loadConfig().acp.bin,
		...(authCapture ? { extraEnv: authCapture.browserEnv, authUrlFile: authCapture.file } : {}),
		log: (msg, data) => {
			if (msg === "auth-url") {
				const { url, port } = (data ?? {}) as { url?: string; port?: number | null };
				if (!url) return;
				const ssh = port ? `\nSSH session? Forward the port on your machine first:\n  ssh -N -L ${port}:127.0.0.1:${port} <user@host>` : "";
				const text = `Google sign-in URL for the ACP engine:\n${url}${ssh}`;
				if (activeUi) activeUi.notify(text, "warning");
				else console.error(`[antigravity-bridge acp] ${text}`);
				return;
			}
			if (!acpFailures.has(msg)) return;
			console.error(`[antigravity-bridge acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`);
		},
		mcpServers: () => {
			const handle = mcpHandle;
			if (!handle) return [];
			// The bridge 403s any request without the shared-secret header; the
			// legacy engine carries it via mcp_config.json, ACP via headers[].
			return [
				{
					name: "pi-bridge",
					type: "http",
					url: `http://127.0.0.1:${handle.port}/mcp`,
					headers: [{ name: TOKEN_HEADER, value: handle.token }],
				},
			];
		},
	});
	// The active engine is resolved from the latched load-time value.
	const activeDriver = (): TurnDriver => (engine === "acp" ? acpDriver : legacyDriver);
	// The provider's stream-json slot gets the LEGACY driver explicitly - never
	// activeDriver(), or a load-time acp engine would make deps.driver and
	// deps.acpDriver the same object and break the engine identity check.
	const driver = legacyDriver;
	// The no-patch pi-tool round-trip store: the MCP bridge parks calls here;
	// the provider emits them as real pi toolUse turns and completes them from
	// the next call's toolResult.
	const roundTrips = new ToolRoundTrips(activeDriver);
	const replay = new WrapperReplay();
	// Native re-exec only emits for builtins actually active in the session;
	// anything else (or an unknown name) falls back to the wrapper card.
	const nativeActive = (name: string): boolean => {
		try {
			const getAll = (pi as unknown as { getAllTools: () => Array<{ name: string }> }).getAllTools.bind(pi);
			return getAll().some((t) => t.name === name);
		} catch {
			return false;
		}
	};
	// A settled turn cannot answer its parked calls; the driver never sees
	// ToolRoundTrips, so the provider bridges the two here (both engines).
	const onTurnEnd = () => roundTrips.failAll("antigravity turn ended with an unresolved pi tool call");
	legacyDriver.onTurnEnd = onTurnEnd;
	acpDriver.onTurnEnd = onTurnEnd;
	const streamSimple = createStreamSimple({
		entries,
		store,
		driver,
		acpDriver,
		roundTrips,
		replay,
		nativeActive,
		engine,
	});

	pi.registerProvider("antigravity", {
		name: "Antigravity (agy)",
		baseUrl: "agy-bridge://antigravity",
		apiKey: "not-used",
		api: "agy-bridge",
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple,
	});

	registerAgyCommand(pi, {
		entries,
		store,
		usingFallback,
		driver,
		acpDriver,
		engine,
		getMcpPort: () => mcpHandle?.port ?? null,
	});

	// AskAntigravity tool: one-shot delegation to agy (ported from
	// pi-ask-antigravity). When both extensions are installed, the bridge wins
	// and pi-ask-antigravity registers nothing (its load-time defer guard
	// detects this package via import.meta.resolve). Opt-out: askTool=false
	// (config file, AGY_ASK_TOOL, /agy ask, or the picker) skips registration
	// entirely - users who want only the provider keep a clean tool list.
	// Note: the active flag below is set regardless of askTool, so
	// pi-ask-antigravity keeps deferring even then: off means NO delegation
	// tool from either package, not a fallback to pi-ask-antigravity.
	if (loadConfig().askTool) await registerAskAntigravityTool(pi, toolModels);

	// Display-only wrapper tool: the provider emits mutating agy steps as
	// toolCalls against it (never re-executed - execute() replays the output
	// agy already recorded). Empty description on purpose: no model should
	// call it, it exists so pi renders proper toolCall/toolResult cards.
	pi.registerTool({
		name: "antigravity",
		label: "Antigravity",
		description: "",
		parameters: Type.Object({
			tool: Type.String({ description: "agy tool name that produced this step." }),
			key: Type.String({ description: "Internal replay key. Do not fabricate." }),
		}),
		execute: async (_toolCallId, params) => {
			const key = (params as { key?: string }).key ?? "";
			const output = replay.take(key) ?? `(no recorded output for ${key})`;
			return { content: [{ type: "text", text: output }], details: { replay: true } };
		},
	});

	// MCP tool bridge: expose pi's tools to agy over localhost Streamable HTTP.
	// Calls park in the provider's round-trip store and complete through pi's
	// normal toolUse loop (native cards, permissions, hooks) - no patch, no
	// privileged API. Started on session_start, torn down on session_shutdown.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) activeUi = ctx.ui;
		// Legacy cleanup: users who ran the old consent-gated patcher still
		// carry pi.invokeTool in their installed pi. Inert, but tell them once
		// and offer /agy patch-cleanup. Never auto-edits the install.
		try {
			if (!loadConfig().patchCleanupNotified && patchStatus().present) {
				// Flag after surfacing, not before: headless sessions log to
				// stderr (ctx.ui.notify is a no-op without a UI), so the notice
				// is never silently dropped.
				const msg =
					"Your pi install still carries the old pi.invokeTool patch. It is unused and harmless; a pi update also removes it. To restore the original files from the backup now: /agy patch-cleanup";
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.error(`[antigravity-bridge] ${msg}`);
				saveConfig({ patchCleanupNotified: true });
			}
		} catch {
			/* detection is best-effort */
		}
		// ACP self-heal: engine=acp needs a server binary + auth. Silent when
		// everything is ready; installs from the registry and bootstraps auth
		// otherwise; manual instructions only on failure. Fire-and-forget: it
		// must not delay session start (and nothing spawns until the first turn).
		if (engine === "acp" && !acpSelfHealRan) {
			acpSelfHealRan = true;
			void ensureAcpReady({ configBin: loadConfig().acp.bin }).then((status) => {
				if (status.ok) {
					if (status.binarySource === "installed" || status.binarySource === "existing") {
						saveConfig({ acp: { bin: status.bin, permissions: loadConfig().acp.permissions } });
					}
					if (status.needsLogin) {
						const msg = acpLoginPending("Your next Antigravity message opens the Google sign-in page in your browser.");
						if (ctx.hasUI) ctx.ui.notify(msg, "warning");
						else console.error(`[antigravity-bridge] ${msg}`);
					}
					return;
				}
				const msg = `ACP auto-setup failed (${status.error}).\n${status.manual}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(`[antigravity-bridge] ${msg}`);
			});
		}
		// Bridge failure logger. Routine lifecycle (listening,
		// bridge-config-written/removed, closed) is normal startup/teardown
		// traffic: toasting it every session, or pinning it via stderr in
		// headless mode, was noise. Only genuine failures surface - as a
		// warning toast (ctx.ui.notify, ephemeral) or stderr when headless.
		// Per-turn success events (list-tools / call-tool) stay silent.
		const mcpLog = (s: string, d?: unknown) => {
			// Routine abort traffic: failAll fires on turn end / session shutdown
			// and the bridge answers every parked call with an error. Not a fault.
			if (s === "call-tool-fail") {
				const detail = (d as { msg?: string } | undefined)?.msg ?? "";
				if (detail.includes("unresolved pi tool call") || detail.includes("session shut down")) return;
			}
			const failures = new Set([
				"http-error", "bridge-config-write-failed", "call-tool-fail",
				"transport-error", "handleRequest-error", "request-error",
				"request-handler-error", "unauthorized",
			]);
			if (!failures.has(s)) return;
			const msg = `[antigravity-bridge mcp] ${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.error(msg);
		};
		// Start the bridge unless the user turned it off. No patch gate, no
		// consent flow: calls route through pi's normal toolUse loop.
		const bridgeMode: BridgeTools = loadConfig().bridgeTools;
		if (bridgeMode === "none") return; // user opted out
		if (mcpHandle) return; // already running (reload re-fires session_start)
		const SKIP = new Set(["AskAntigravity"]);
		// pi loads project skill locations only after the project is trusted;
		// mirror that gate. Global skill dirs are always scanned.
		const skills: SkillLite[] = scanSkills(ctx.isProjectTrusted() ? process.cwd() : undefined);
		const getAll = (pi as unknown as {
			getAllTools: () => Array<{ name: string; description?: string; parameters?: object; sourceInfo?: { source?: string } }>;
		}).getAllTools.bind(pi);
		const listTools = () => {
			const all = getAll();
			const filtered =
				bridgeMode === "mcp"
					? all.filter((t) => /pi-mcp-adapter/.test(t.sourceInfo?.source ?? ""))
					: all.filter((t) => t.sourceInfo?.source !== "builtin");
			const tools = filtered
				.filter((t) => !SKIP.has(t.name))
				.map((t) => {
					let inputSchema: object = { type: "object", properties: {}, additionalProperties: true };
					try {
						if (t.parameters) inputSchema = JSON.parse(JSON.stringify(t.parameters)) as object;
					} catch {
						/* keep default schema */
					}
					return { name: t.name, description: t.description ?? t.name, inputSchema };
				});
			if (skills.length > 0) {
				tools.push({
					name: ACTIVATE_SKILL_TOOL_NAME,
					description: `Activate a pi Agent Skill by name. Catalog:\n${catalogSummary(skills)}`,
					inputSchema: activateSkillSchema(skills) as object,
				});
			}
			return tools;
		};
		// activate_skill never round-trips through pi: the bridge answers it
		// directly by reading the SKILL.md (pi has no skill tool to execute).
		const bridgeOnToolCall = (
			callId: string,
			name: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
		) => {
			if (name !== ACTIVATE_SKILL_TOOL_NAME) return roundTrips.onToolCall(callId, name, args, signal);
			const wanted = typeof args.name === "string" ? args.name : "";
			const skill = findSkillByName(skills, wanted);
			const body = skill ? readSkillBody(skill) : `unknown skill: ${wanted || "(none given)"}`;
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: skill ? `${body}\n\n[skill resources dir: ${skill.dir}]` : `Error: ${body}`,
					},
				],
				isError: !skill,
			});
		};
		const r = await startMcpServer({ listTools, onToolCall: bridgeOnToolCall }, { log: mcpLog });
		if (r.ok && r.handle) {
			mcpHandle = r.handle;
		} else {
			console.error(`[antigravity-bridge] MCP tool bridge disabled: ${r.reason}`);
		}
	});
	pi.on("session_shutdown", async () => {
		// The UI is going away; a later auth-url must fall back to stderr
		// instead of toasting into a dead UI (where it would be lost).
		activeUi = null;
		const h = mcpHandle;
		mcpHandle = null;
		await h?.close();
		roundTrips.failAll("antigravity session shut down");
		await legacyDriver.close("shutdown");
		await acpDriver.close("shutdown");
	});
}

// --- /agy command -----------------------------------------------------------

/** Shared body for every ACP-login-pending moment (session_start self-heal,
 *  /agy engine acp, picker). End-user simple: what happens, when, which
 *  account. The server opens the browser itself, so there is no URL to
 *  open manually. `browserTrigger` says when that happens. */
function acpLoginPending(browserTrigger: string): string {
	return `One-time sign-in needed to finish ACP setup. ${browserTrigger} Use the Google account of your Antigravity subscription (the same account as your agy CLI login). If no browser opens, pi shows the sign-in URL to copy. The token stays on your machine; this extension never sees it.`;
}

interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
	driver: TurnDriver;
	acpDriver: AcpDriver;
	/** Engine latched at extension load (see the provider wiring note). */
	engine: Engine;
	getMcpPort: () => number | null;
}

interface PendingConfig {
	mode?: AgyMode;
	skipPermissions?: boolean;
	defaultModel?: string;
	defaultThinking?: ThinkingTier;
	askTool?: boolean;
	bridgeTools?: BridgeTools;
	digest?: boolean;
	systemPrompt?: boolean;
}

function statusText(ctx: AgyCommandCtx): string {
	const config = loadConfig();
	const source = ctx.usingFallback ? "fallback (agy models failed)" : "discovered";
	const perm = config.skipPermissions ? "auto-approved (DANGEROUS)" : "prompt (hangs in -p)";
	// padEnd keyed to the longest label ("AskAntigravity thinking:") so the
	// value column stays aligned as labels grow.
	const row = (label: string, value: string) => `  ${label.padEnd(24)} ${value}`;
	return [
		"Antigravity bridge",
		row("engine:", `${config.engine}${config.engine === "acp" ? " (official server, opt-in)" : ""}`),
		row("models:", `${ctx.entries.length} ${source}`),
		row("mode:", config.mode),
		row("permissions:", perm),
		row("AskAntigravity tool:", config.askTool ? "on" : "off"),
		row("AskAntigravity model:", config.defaultModel),
		row("AskAntigravity thinking:", config.defaultThinking),
		row("sessions:", `${ctx.store.size} bound`),
		row("config:", CONFIG_PATH),
		row("bridge tools:", config.bridgeTools),
		row("digest:", config.digest ? "on" : "off"),
		row("system prompt:", config.systemPrompt ? "on" : "off"),
		"",
		"Subcommands: /agy engine stream-json|acp, /agy mode plan|accept-edits, /agy permissions on|off, /agy ask on|off, /agy model <alias>, /agy thinking low|medium|high, /agy bridge all|mcp|none, /agy digest on|off, /agy system-prompt on|off, /agy acp-bin <path|auto>, /agy acp-auth, /agy patch-cleanup, /agy clear",
	].join("\n");
}


function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity provider: status, doctor, settings picker, clear sessions. Usage: /agy [status|doctor|engine stream-json|acp|mode plan|accept-edits|permissions on|off|ask on|off|model <alias>|thinking low|medium|high|bridge all|mcp|none|digest on|off|system-prompt on|off|acp-bin <path|auto>|acp-auth|patch-cleanup|clear]",
		handler: async (args, cmdCtx: ExtensionCommandContext) => {
			const ui = cmdCtx.ui;
			if (ui) activeUi = ui;
			const mode = cmdCtx.mode;
			const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
			const val = (args ?? "").trim().split(/\s+/)[1]?.toLowerCase();

			// Direct subcommands work everywhere (headless + TUI).
			if (sub === "clear") {
				ctx.store.clear();
				ui?.notify("Cleared all antigravity session bindings.", "info");
				return;
			}
			if (sub === "patch-cleanup") {
				const st = patchStatus();
				if (!st.present) {
					ui?.notify(
						st.root
							? `No invokeTool patch detected on pi ${st.version}. Nothing to clean.`
							: "Could not locate the installed pi package. Nothing cleaned.",
						"info",
					);
					return;
				}
				const r = restorePatch();
				ui?.notify(
					r.ok
						? `Restored ${r.restoredFiles.length} file(s) from ${r.backupDir}. The running session is unaffected; the files on disk are clean again.`
						: `patch-cleanup failed: ${r.reason}`,
					r.ok ? "info" : "error",
				);
				return;
			}
			if (sub === "engine") {
				if (val === "acp" || val === "stream-json") {
					if (val === "acp" && loadConfig().mode === "plan") {
						ui?.notify("mode is plan; the ACP engine has no plan mode. /agy mode accept-edits first.", "warning");
						return;
					}
					const next = saveConfig({ engine: val });
					if (next.engine !== "acp") {
						ui?.notify("engine set to stream-json. Takes effect on the next pi start (or /reload).", "info");
						return;
					}
					// Self-service setup: install the server from the official
					// registry and bootstrap auth now, so the restart just works.
					// Manual instructions only when a step fails.
					ui?.notify("engine set to acp. Preparing the server (binary + auth)…", "info");
					const status = await ensureAcpReady({
						configBin: loadConfig().acp.bin,
						onProgress: (m) => ui?.notify(m, "info"),
					});
					if (!status.ok) {
						ui?.notify(`ACP auto-setup failed (${status.error}).\n${status.manual}`, "warning");
						return;
					}
					saveConfig({ acp: { bin: status.bin, permissions: loadConfig().acp.permissions } });
					if (status.needsLogin) {
						ui?.notify(
							`ACP engine set. ${acpLoginPending("After the restart (pi restart or /reload), your first Antigravity message opens the Google sign-in page in your browser.")}`,
							"warning",
						);
					} else {
						ui?.notify(`ACP engine ready (auth: ${status.auth}). Takes effect on the next pi start (or /reload).`, "info");
					}
				} else {
					ui?.notify(`current engine: ${loadConfig().engine}\nusage: /agy engine stream-json|acp`, "info");
				}
				return;
			}
			if (sub === "acp-bin") {
				const rest = (args ?? "").trim().split(/\s+/).slice(1).join(" ");
				if (rest.length > 0) {
					// Only the keyword compares case-insensitively; the path keeps its case.
					const bin = rest.toLowerCase() === "auto" ? "" : rest.replace(/^~(?=\/|$)/, os.homedir());
					saveConfig({ acp: { bin, permissions: loadConfig().acp.permissions } });
					ui?.notify(
						bin
							? `acp.bin set to ${bin}. The next ACP turn (re)connects with it.`
							: "acp.bin cleared. Auto-setup (or AGY_ACP_BIN) picks the binary on the next ACP turn.",
						"info",
					);
				} else {
					const cur = loadConfig().acp.bin;
					ui?.notify(`acp.bin: ${cur || "(auto: setup installs, or AGY_ACP_BIN)"}\nusage: /agy acp-bin <path|auto>`, "info");
				}
				return;
			}
			if (sub === "acp-auth") {
				ui?.notify(
					[
						"ACP engine authentication (one-time; usually automatic -",
						"/agy engine acp and session start set this up for you):",
						"",
						"The server is Google's official Antigravity ACP, installed from Google's",
						"own registry. Logging in uses your Antigravity subscription: the same",
						"Google account and plan as the Antigravity CLI (agy). It is no different",
						"from logging into the CLI; the server just keeps its own token file on",
						"your machine, like any Google tool. This extension never sees your",
						"credentials.",
						"",
						"1. Server binary: auto-setup installs it. Manual: agy_acp_server.par from",
						"   the antigravity-acp registry; point acp.bin or AGY_ACP_BIN at it.",
						'2. Default: put {"auth":{"type":"oauth-personal"}} in',
						"   ~/.gemini/antigravity-acp/settings.json, run one turn, and complete the",
						"   Google login that opens in your browser. No browser (SSH session)?",
						"   pi shows the sign-in URL to copy; forward the redirect port over ssh",
						"   (ssh -N -L <port>:127.0.0.1:<port> <user@host>), then open the URL",
						"   on your machine.",
						'   Headless alternative: GEMINI_API_KEY + {"auth":{"type":"gemini-api-key"}}',
						"   (metered paid API - not your Antigravity plan). The key is used only",
						"   when that type is selected; with the default oauth-personal in place,",
						"   an exported key is ignored.",
						"3. Run one turn; /agy doctor shows the server version when auth is OK.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "doctor") {
				const config = loadConfig();
				const engine = ctx.engine;
				const snap = (engine === "acp" ? ctx.acpDriver : ctx.driver).snapshot();
				const port = ctx.getMcpPort();
				const lines = [
					"Antigravity doctor (no tokens spent)",
					`  engine:        ${engine}`,
					`  bridge:        ${config.bridgeTools}${port ? ` (port ${port})` : " (not running)"}`,
					`  driver:        ${snap.state}${snap.pid ? ` pid=${snap.pid}` : ""}${snap.conversationId ? ` session=${snap.conversationId.slice(0, 8)}` : ""}`,
					`  driver stats:  spawns=${snap.stats.spawns} turns=${snap.stats.turns} reused=${snap.stats.reused} recycles=${snap.stats.recycles}${snap.stats.lastRecycleReason ? ` (last: ${snap.stats.lastRecycleReason})` : ""}`,
					`  sessions:      ${ctx.store.size} bound`,
					`  models:        ${ctx.entries.length} ${ctx.usingFallback ? "FALLBACK (agy models failed)" : "discovered"}`,
					`  config:        ${CONFIG_PATH}`,
				];
				if (snap.engine === "acp" && snap.acp) {
					lines.push(
						`  acp session:   ${snap.acp.sessionId ?? "(none)"}`,
						`  acp server:    ${snap.acp.serverVersion ?? "unknown"}${snap.acp.agentTitle ? ` (${snap.acp.agentTitle})` : ""}`,
						`  acp stats:     prompts=${snap.acp.prompts} created=${snap.acp.sessionsCreated} loaded=${snap.acp.sessionsLoaded} kills=${snap.acp.kills} reconnects=${snap.acp.reconnects} cancel=${snap.acp.cancelSupported === null ? "unprobed" : snap.acp.cancelSupported ? "supported" : "unsupported (kill+reload)"}`,
					);
				}
				if (snap.lifecycle.length > 0) {
					lines.push("  lifecycle (last 5):");
					for (const entry of snap.lifecycle.slice(-5)) lines.push(`    ${entry}`);
				}
				if (engine === "acp") {
					const setup = inspectAcpSetup({ configBin: config.acp.bin });
					lines.push(
						`  acp binary:    ${setup.bin ?? "not found (auto-setup offers install)"}${setup.source ? ` (${setup.source})` : ""}`,
						`  acp auth:      ${setup.auth ?? "not configured (auto-setup bootstraps)"}`,
					);
				}
				ui?.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "mode") {
				if (val === "plan" || val === "accept-edits") {
					if (val === "plan" && ctx.engine === "acp") {
						ui?.notify("the ACP engine has no plan mode (RC01). /agy engine stream-json first, or /agy mode accept-edits.", "warning");
						return;
					}
					const next = saveConfig({ mode: val as AgyMode });
					ui?.notify(`mode set to ${next.mode}`, "info");
				} else {
					ui?.notify(`current mode: ${loadConfig().mode}\nusage: /agy mode plan|accept-edits`, "info");
				}
				return;
			}
			if (sub === "permissions") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ skipPermissions: val === "on" });
					const warn = next.skipPermissions ? "\nWARNING: agy can now run arbitrary commands without review." : "";
					ui?.notify(`permissions: ${next.skipPermissions ? "auto-approved (DANGEROUS)" : "prompt"}${warn}`, next.skipPermissions ? "warning" : "info");
				} else {
					ui?.notify(`permissions: ${loadConfig().skipPermissions ? "auto-approved (DANGEROUS)" : "prompt"}\nusage: /agy permissions on|off\n(off hangs any run_command in non-interactive mode)`, "info");
				}
				return;
			}
			if (sub === "bridge") {
				if (val === "all" || val === "mcp" || val === "none") {
					const next = saveConfig({ bridgeTools: val });
					ui?.notify(
						next.bridgeTools === "none"
							? "bridge off. The MCP tool bridge will not start on the next pi start (or /reload)."
							: `bridge tools set to ${next.bridgeTools}. The catalog rebuilds on the next pi start (or /reload).`,
						"info",
					);
				} else {
					ui?.notify(`bridge: ${loadConfig().bridgeTools}\nusage: /agy bridge all|mcp|none\n  all: every non-builtin pi tool (default). mcp: pi-mcp-adapter tools + skills only. none: bridge off.`, "info");
				}
				return;
			}
			if (sub === "model") {
				if (val && val.length > 0) {
					const next = saveConfig({ defaultModel: val });
					ui?.notify(`AskAntigravity default model set to ${next.defaultModel}`, "info");
				} else {
					ui?.notify(`AskAntigravity model: ${loadConfig().defaultModel} (fallback; callers may override per call)\nusage: /agy model flash|pro|gemini|<exact>`, "info");
				}
				return;
			}
			if (sub === "ask") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ askTool: val === "on" });
					ui?.notify(
						next.askTool
							? "AskAntigravity tool on. Registered on the next pi start (or /reload)."
							: "AskAntigravity tool off. It is removed from the model's tool list on the next pi start (or /reload). Provider and models stay.",
						"info",
					);
				} else {
					ui?.notify(`AskAntigravity tool: ${loadConfig().askTool ? "on" : "off"}\nusage: /agy ask on|off`, "info");
				}
				return;
			}
			if (sub === "digest") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ digest: val === "on" });
					ui?.notify(
						next.digest
							? "digest on. pi-side context (compaction summaries, other-provider turns) is injected into each agy prompt. Note: this defeats agy's prompt cache (~25-30k tokens re-billed per turn)."
							: "digest off. agy prompts contain only your message; agy's prompt cache stays stable. Enable when mixing providers in one session and agy must see pi-side context.",
						"info",
					);
				} else {
					ui?.notify(`digest: ${loadConfig().digest ? "on" : "off"}\nusage: /agy digest on|off`, "info");
				}
				return;
			}
			if (sub === "system-prompt") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ systemPrompt: val === "on" });
					ui?.notify(
						next.systemPrompt
							? "system-prompt on. pi's system prompt (incl. global and project AGENTS.md) is prepended to the first prompt of each new agy conversation. Existing conversations keep the version they started with."
							: "system-prompt off. agy runs on its own system prompt; pi instructions and AGENTS.md files are not sent.",
						"info",
					);
				} else {
					ui?.notify(`system-prompt: ${loadConfig().systemPrompt ? "on" : "off"}\nusage: /agy system-prompt on|off`, "info");
				}
				return;
			}

			if (sub === "thinking") {
				if (val === "low" || val === "medium" || val === "high") {
					const next = saveConfig({ defaultThinking: val as ThinkingTier });
					ui?.notify(`AskAntigravity default thinking set to ${next.defaultThinking}`, "info");
				} else {
					ui?.notify(`AskAntigravity thinking: ${loadConfig().defaultThinking} (fallback; callers may override per call)\nusage: /agy thinking low|medium|high`, "info");
				}
				return;
			}


			// No subcommand (or "status"): print status, or open the picker in TUI.
			if (sub && sub !== "status") {
				ui?.notify(`unknown subcommand: ${sub}\n${statusText(ctx)}`, "warning");
				return;
			}

			if (mode !== "tui" || !ui) {
				ui?.notify(statusText(ctx), "info");
				return;
			}

			await openAgyPicker(ui, ctx);
		},
	});
}

/** Interactive settings picker (TUI only). Rows: the runtime config surface
 *  (mode, permissions, model, thinking, bridge, digest, system prompt).
 *  Engine switching is command-only: /agy engine stream-json|acp (the
 *  command also runs self-service binary + auth setup for acp). */
async function openAgyPicker(ui: ExtensionUIContext, ctx: AgyCommandCtx): Promise<void> {
	const config = loadConfig();
	const pending: PendingConfig = {};

	const items: SettingItem[] = [
		{
			id: "mode",
			label: "Execution mode",
			description:
				"accept-edits: agy applies edits directly. plan: review-only, no writes. Takes effect next turn.",
			currentValue: config.mode,
			values: ["accept-edits", "plan"],
		},
		{
			id: "permissions",
			label: "Permissions",
			description:
				"auto-approved: --dangerously-skip-permissions (required so commands don't hang in -p mode). prompt: agy asks y/n (hangs non-interactively).",
			currentValue: config.skipPermissions ? "auto-approved" : "prompt",
			values: ["auto-approved", "prompt"],
		},
		{
			id: "ask",
			label: "AskAntigravity tool",
			description:
				"Register the AskAntigravity one-shot delegation tool. off removes it from the model's tool list (provider and models stay, even with the separate pi-ask-antigravity package installed). Takes effect on the next pi start (or /reload).",
			currentValue: config.askTool ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "model",
			label: "AskAntigravity model",
			description:
				"AskAntigravity one-shot delegation tool: model used when its caller omits the model param. Callers may override per call; this is only the fallback. flash/pro/gemini, or an exact id. Does not affect the provider model you pick in /model.",
			currentValue: config.defaultModel,
			values: ["flash", "pro", "gemini"],
		},
		{
			id: "thinking",
			label: "AskAntigravity thinking",
			description:
				"AskAntigravity one-shot delegation tool: thinking tier used when the call names none. Callers may override per call; this is only the fallback. Pro has no Medium; it falls back to nearest.",
			currentValue: config.defaultThinking,
			values: ["low", "medium", "high"],
		},
		{
			id: "bridge",
			label: "Bridge tools",
			description:
				"Which pi tools the MCP bridge exposes to agy. all: every non-builtin tool (default). mcp: pi-mcp-adapter tools + skills. none: bridge off.",
			currentValue: config.bridgeTools,
			values: ["all", "mcp", "none"],
		},
		{
			id: "digest",
			label: "Context digest",
			description:
				"Inject a delta of pi-side context into each agy prompt. Defeats agy's prompt cache (~25-30k tokens re-billed per turn).",
			currentValue: config.digest ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "system-prompt",
			label: "System prompt",
			description:
				"Prepend pi's system prompt (incl. AGENTS.md files) to the first prompt of each new agy conversation.",
			currentValue: config.systemPrompt ? "on" : "off",
			values: ["on", "off"],
		},
	];

	await ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Antigravity provider")), 1, 1),
		);
		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 4, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "mode") {
					pending.mode = newValue as AgyMode;
				} else if (id === "permissions") {
					pending.skipPermissions = newValue === "auto-approved";
				} else if (id === "model") {
					pending.defaultModel = newValue;
				} else if (id === "thinking") {
					pending.defaultThinking = newValue as ThinkingTier;
				} else if (id === "ask") {
					pending.askTool = newValue === "on";
				} else if (id === "bridge") {
					pending.bridgeTools = newValue as BridgeTools;
				} else if (id === "digest") {
					pending.digest = newValue === "on";
				} else if (id === "system-prompt") {
					pending.systemPrompt = newValue === "on";
				}
			},
			() => done(undefined),
		);
		container.addChild(settingsList);

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});

	if (Object.keys(pending).length === 0) return;

	// The picker cannot switch engines (command-only: /agy engine), but the
	// mode row can still produce plan while the latched engine is acp. ACP
	// has no review-only mode (RC01); refuse the combination.
	const nextMode = pending.mode ?? config.mode;
	if (nextMode === "plan" && ctx.engine === "acp") {
		ui.notify(
			"plan + acp is not supported (RC01): the ACP engine has no review-only mode. /agy engine stream-json first, or /agy mode accept-edits.",
			"warning",
		);
		return;
	}

	try {
		const next = saveConfig(pending);
		const changed = [
			pending.mode ? `mode=${next.mode}` : null,
			pending.skipPermissions !== undefined
				? `permissions=${next.skipPermissions ? "auto-approved" : "prompt"}`
				: null,
			pending.askTool !== undefined ? `AskAntigravity tool=${next.askTool ? "on" : "off"}` : null,
			pending.defaultModel !== undefined ? `AskAntigravity model=${next.defaultModel}` : null,
			pending.defaultThinking !== undefined ? `AskAntigravity thinking=${next.defaultThinking}` : null,
			pending.bridgeTools !== undefined ? `bridge=${next.bridgeTools}` : null,
			pending.digest !== undefined ? `digest=${next.digest ? "on" : "off"}` : null,
			pending.systemPrompt !== undefined ? `system-prompt=${next.systemPrompt ? "on" : "off"}` : null,
		]
			.filter(Boolean)
			.join(", ");
		ui.notify(`Saved: ${changed}`, "info");
	} catch (err) {
		ui.notify(
			`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}
