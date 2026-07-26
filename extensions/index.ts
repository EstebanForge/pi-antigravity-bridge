// pi-antigravity-bridge - extension entry point.
//
// Registers Gemini (via the agy CLI) as a pi model provider so it shows up in
// the /model picker as antigravity/gemini-*. When selected, pi routes each turn
// through streamSimple, which spawns `agy -p`, polls the conversation SQLite DB
// agy writes, decodes the protobuf step payloads, and streams the agent text
// back into pi's TUI.
//
// Architectural wall (cannot be worked around - see PLAN.md):
//   agy runs its OWN closed tool loop against --add-dir. pi's read/write/edit/
//   bash tools never fire. Tool activity is surfaced as thinking events
//   ("[agy tool: editing foo.ts]") for visibility, but the edits already landed
//   on disk and pi's inline diff review does not engage.
//
// /agy command: status, mode picker (plan / accept-edits), narration toggle,
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
import { createStreamSimple } from "../src/provider.js";
import { CONFIG_PATH, loadConfig, saveConfig, type AgyMode, type ThinkingTier } from "../src/config.js";
import { registerAskAntigravityTool, toolModelsFromRaw } from "../src/ask-tool.js";
import { startMcpServer, type McpServerHandle } from "../src/mcp-server.js";

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
	const streamSimple = createStreamSimple({ entries, store });

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
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple,
	});

	registerAgyCommand(pi, { entries, store, usingFallback });

	// AskAntigravity tool: one-shot delegation to agy (ported from
	// pi-ask-antigravity). When both extensions are installed, the bridge wins
	// and pi-ask-antigravity registers nothing (its load-time defer guard
	// detects this package via import.meta.resolve).
	await registerAskAntigravityTool(pi, toolModels);

	// MCP tool bridge: expose pi's tools to agy over localhost Streamable HTTP,
	// backed by pi.invokeTool (local patch). Capability-gated: if the running pi
	// lacks invokeTool, startMcpServer returns { ok: false } and the bridge runs
	// unchanged (other instances do not break). Started on session_start so it is
	// live before the provider's first turn; torn down on session_shutdown.
	let mcpHandle: McpServerHandle | null = null;
	const mcpLog = (s: string, d?: unknown) => {
		// Quiet by default: surface only lifecycle/error events to stderr.
		// Lifecycle + error events only. Per-turn success events (list-tools /
		// call-tool) are deliberately NOT surfaced: writing to stderr during an
		// active turn corrupts the pi TUI / construct daemon rendering (spinner
		// gets stuck, hint text leaks into the display). Use a status-bar API for
		// in-turn visibility instead.
		const surfaced = new Set([
			"listening", "capability-missing", "http-error", "closed",
			"bridge-config-written", "bridge-config-removed", "bridge-config-write-failed",
			"call-tool-fail", "transport-error", "handleRequest-error",
			"request-error", "request-handler-error", "unauthorized",
		]);
		if (surfaced.has(s)) {
			console.error(`[antigravity-bridge mcp] ${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`);
		}
	};
	pi.on("session_start", async () => {
		if (mcpHandle) return; // already running (reload re-fires session_start)
		const r = await startMcpServer(pi, { log: mcpLog });
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
	});
}

// --- /agy command -----------------------------------------------------------

interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
}

interface PendingConfig {
	mode?: AgyMode;
	filterNarration?: boolean;
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
		`  models:        ${ctx.entries.length} ${source}`,
		`  mode:          ${config.mode}`,
		`  permissions:   ${perm}`,
		`  narration:     ${config.filterNarration ? "filtered" : "raw"}`,
		`  tool model:    ${config.defaultModel}`,
		`  tool thinking: ${config.defaultThinking}`,
		`  sessions:      ${ctx.store.size} bound`,
		`  config:        ${CONFIG_PATH}`,
		"",
		"Subcommands: /agy mode plan|accept-edits, /agy permissions on|off, /agy narration on|off, /agy model flash|pro|gemini, /agy thinking low|medium|high, /agy clear",
	].join("\n");
}

function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity provider: status, mode picker, narration toggle, clear sessions. Usage: /agy [status|mode [plan|accept-edits]|narration [on|off]|clear]",
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
			if (sub === "narration") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ filterNarration: val === "on" });
					ui?.notify(`narration ${next.filterNarration ? "filtered" : "raw"}`, "info");
				} else {
					ui?.notify(
						`narration: ${loadConfig().filterNarration ? "filtered" : "raw"}\nusage: /agy narration on|off`,
						"info",
					);
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

/** Interactive settings picker (TUI only). Rows: mode + narration + permissions. */
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
			id: "narration",
			label: "Narration filter",
			description:
				"filtered: drop agy's 'I will ...' planning chunks. raw: stream everything agy emits.",
			currentValue: config.filterNarration ? "filtered" : "raw",
			values: ["filtered", "raw"],
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
				} else if (id === "narration") {
					pending.filterNarration = newValue === "filtered";
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
		pending.filterNarration === undefined &&
		pending.skipPermissions === undefined &&
		pending.defaultModel === undefined &&
		pending.defaultThinking === undefined
	)
		return;

	try {
		const next = saveConfig(pending);
		const changed = [
			pending.mode ? `mode=${next.mode}` : null,
			pending.filterNarration !== undefined
				? `narration=${next.filterNarration ? "filtered" : "raw"}`
				: null,
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
