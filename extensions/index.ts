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
// /agy command: status, mode picker (plan / accept-edits),
// and session clear. Config persists to ~/.pi/agent/antigravity-bridge/
// config.json so toggles survive restarts.

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
import { resolveAcpBinary } from "../src/acp/connection.js";
import type { TurnDriver } from "../src/driver-types.js";
import { CONFIG_PATH, loadConfig, saveConfig, type AgyMode, type BridgeTools, type ThinkingTier } from "../src/config.js";
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
	const models = entries.map(toPiModel);

	const store = new SessionStore();
	// MCP bridge handle, declared early: the ACP engine reads the bridge port
	// at session/new / session/load time.
	let mcpHandle: McpServerHandle | null = null;
	// Two turn engines behind one contract (plan §9): stream-json (tested
	// default) and the official ACP server (opt-in via config.engine, off by
	// default). Neither spawns anything until its first turn.
	const legacyDriver = new AgyDriver();
	const acpDriver = new AcpDriver({
		bin: resolveAcpBinary(loadConfig().acp.bin),
		log: (msg, data) =>
			console.error(`[antigravity-bridge acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
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
	// The active engine is resolved per call from config (engine switches take
	// effect on restart, when drivers re-wire).
	const activeDriver = (): TurnDriver => (loadConfig().engine === "acp" ? acpDriver : legacyDriver);
	const driver = activeDriver();
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
	driver.onTurnEnd = onTurnEnd;
	acpDriver.onTurnEnd = onTurnEnd;
	const streamSimple = createStreamSimple({ entries, store, driver, acpDriver, roundTrips, replay, nativeActive });

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
		getMcpPort: () => mcpHandle?.port ?? null,
	});

	// AskAntigravity tool: one-shot delegation to agy (ported from
	// pi-ask-antigravity). When both extensions are installed, the bridge wins
	// and pi-ask-antigravity registers nothing (its load-time defer guard
	// detects this package via import.meta.resolve).
	await registerAskAntigravityTool(pi, toolModels);

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
		// Bridge lifecycle/error logger. Routes through ctx.ui.notify (an
		// ephemeral toast that fades) instead of stderr: pi's TUI captures stderr
		// and pins it above the input for the whole session, which left the
		// startup "bridge-config-written" / "listening" lines stuck on screen all
		// session. Headless modes (print/json, hasUI === false) have no toast, so
		// fall back to stderr there. Per-turn success events (list-tools /
		// call-tool) stay silent either way.
		const mcpLog = (s: string, d?: unknown) => {
			const surfaced = new Set([
				"listening", "capability-missing", "http-error", "closed",
				"bridge-config-written", "bridge-config-removed", "bridge-config-write-failed",
				"call-tool-fail", "transport-error", "handleRequest-error",
				"request-error", "request-handler-error", "unauthorized", "self-patch-error",
			]);
			if (!surfaced.has(s)) return;
			const msg = `[antigravity-bridge mcp] ${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`;
			if (ctx.hasUI) {
				const ok = s === "listening" || s === "bridge-config-written"
					|| s === "bridge-config-removed" || s === "closed";
				ctx.ui.notify(msg, ok ? "info" : "warning");
			} else {
				console.error(msg);
			}
		};
		// Start the bridge unless the user turned it off. No patch gate, no
		// consent flow: calls route through pi's normal toolUse loop.
		const bridgeMode: BridgeTools = loadConfig().bridgeTools;
		if (bridgeMode === "none") return; // user opted out
		if (mcpHandle) return; // already running (reload re-fires session_start)
		const SKIP = new Set(["AskAntigravity"]);
		const skills: SkillLite[] = scanSkills(process.cwd());
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
		const h = mcpHandle;
		mcpHandle = null;
		await h?.close();
		roundTrips.failAll("antigravity session shut down");
		await legacyDriver.close("shutdown");
		await acpDriver.close("shutdown");
	});
}

// --- /agy command -----------------------------------------------------------

interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
	driver: TurnDriver;
	acpDriver: AcpDriver;
	getMcpPort: () => number | null;
}

interface PendingConfig {
	mode?: AgyMode;
	skipPermissions?: boolean;
	defaultModel?: string;
	defaultThinking?: ThinkingTier;
}

function statusText(ctx: AgyCommandCtx): string {
	const config = loadConfig();
	const source = ctx.usingFallback ? "fallback (agy models failed)" : "discovered";
	const perm = config.skipPermissions ? "auto-approved (DANGEROUS)" : "prompt (hangs in -p)";
	return [
		"Antigravity bridge",
		`  engine:        ${config.engine}${config.engine === "acp" ? " (official server, opt-in)" : ""}`,
		`  models:        ${ctx.entries.length} ${source}`,
		`  mode:          ${config.mode}`,
		`  permissions:   ${perm}`,
		`  tool model:    ${config.defaultModel}`,
		`  tool thinking: ${config.defaultThinking}`,
		`  sessions:      ${ctx.store.size} bound`,
		`  config:        ${CONFIG_PATH}`,
		`  bridge tools:  ${config.bridgeTools}`,
		`  digest:        ${config.digest ? "on" : "off"}`,
		`  system prompt: ${config.systemPrompt ? "on" : "off"}`,
		"",
		"Subcommands: /agy engine stream-json|acp, /agy mode plan|accept-edits, /agy permissions on|off, /agy model flash|pro|gemini, /agy thinking low|medium|high, /agy digest on|off, /agy system-prompt on|off, /agy acp-auth, /agy patch-cleanup, /agy clear",
	].join("\n");
}


function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity provider: status, doctor, engine picker, mode picker, clear sessions. Usage: /agy [status|doctor|engine stream-json|acp|mode [plan|accept-edits]|permissions on|off|digest on|off|system-prompt on|off|acp-auth|patch-cleanup|clear]",
		handler: async (args, cmdCtx: ExtensionCommandContext) => {
			const ui = cmdCtx.ui;
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
					const next = saveConfig({ engine: val });
					ui?.notify(
						`engine set to ${next.engine}. Takes effect on the next pi start (or /reload).${next.engine === "acp" ? "\nRequires the official ACP server binary (AGY_ACP_BIN or acp.bin) and a one-time auth: /agy acp-auth" : ""}`,
						"info",
					);
				} else {
					ui?.notify(`current engine: ${loadConfig().engine}\nusage: /agy engine stream-json|acp`, "info");
				}
				return;
			}
			if (sub === "acp-auth") {
				ui?.notify(
					[
						"ACP engine authentication (one-time):",
						"1. Install the server binary (agy_acp_server.par from the ACP registry",
						"   build URL) and point acp.bin or AGY_ACP_BIN at it.",
						"2. Pick one credential path:",
						'   - oauth-personal: put {"auth":{"type":"oauth-personal"}} in',
						"     ~/.gemini/antigravity-acp/settings.json, run one turn, and open the",
						"     login URL the server produces (headless: tunnel 127.0.0.1:<port>",
						"     over ssh, then open the URL on your machine).",
						'   - gemini-api-key: export GEMINI_API_KEY and set',
						'     {"auth":{"type":"gemini-api-key"}} (headless-friendly; metered).',
						"   The agent never reads or writes your credentials.",
						"3. Run one turn; /agy doctor shows the server version when auth is OK.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "doctor") {
				const config = loadConfig();
				const engine = config.engine;
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
						`  acp server:    ${snap.acp.serverVersion ?? "unknown"}`,
						`  acp stats:     prompts=${snap.acp.prompts} created=${snap.acp.sessionsCreated} loaded=${snap.acp.sessionsLoaded} kills=${snap.acp.kills} cancel=${snap.acp.cancelSupported === null ? "unprobed" : snap.acp.cancelSupported ? "supported" : "unsupported (kill+reload)"}`,
					);
				}
				if (snap.lifecycle.length > 0) {
					lines.push("  lifecycle (last 5):");
					for (const entry of snap.lifecycle.slice(-5)) lines.push(`    ${entry}`);
				}
				ui?.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "mode") {
				if (val === "plan" || val === "accept-edits") {
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
			if (sub === "model") {
				if (val && val.length > 0) {
					const next = saveConfig({ defaultModel: val });
					ui?.notify(`tool default model set to ${next.defaultModel}`, "info");
				} else {
					ui?.notify(`tool model: ${loadConfig().defaultModel}\nusage: /agy model flash|pro|gemini|<exact>`, "info");
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
					ui?.notify(`tool default thinking set to ${next.defaultThinking}`, "info");
				} else {
					ui?.notify(`tool thinking: ${loadConfig().defaultThinking}\nusage: /agy thinking low|medium|high`, "info");
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

/** Interactive settings picker (TUI only). Rows: mode + permissions + model + thinking. */
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
			id: "model",
			label: "Tool default model",
			description:
				"Alias used when the AskAntigravity tool omits its model param. flash/pro/gemini, or an exact id.",
			currentValue: config.defaultModel,
			values: ["flash", "pro", "gemini"],
		},
		{
			id: "thinking",
			label: "Tool default thinking",
			description:
				"Thinking tier used when the model alias names none. Pro has no Medium; it falls back to nearest.",
			currentValue: config.defaultThinking,
			values: ["low", "medium", "high"],
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

	if (
		pending.mode === undefined &&
		pending.skipPermissions === undefined &&
		pending.defaultModel === undefined &&
		pending.defaultThinking === undefined
	)
		return;

	try {
		const next = saveConfig(pending);
		const changed = [
			pending.mode ? `mode=${next.mode}` : null,
			pending.skipPermissions !== undefined
				? `permissions=${next.skipPermissions ? "auto-approved" : "prompt"}`
				: null,
			pending.defaultModel !== undefined ? `tool model=${next.defaultModel}` : null,
			pending.defaultThinking !== undefined ? `tool thinking=${next.defaultThinking}` : null,
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
	void ctx;
}
