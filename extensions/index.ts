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
import { createStreamSimple } from "../src/provider.js";
import { CONFIG_PATH, loadConfig, saveConfig, type AgyMode, type ThinkingTier } from "../src/config.js";
import { registerAskAntigravityTool, toolModelsFromRaw } from "../src/ask-tool.js";
import { hasInvokeTool, startMcpServer, type McpServerHandle } from "../src/mcp-server.js";
import { applyInvokeToolPatch, decidePatchAction, patchStatus, restorePatch } from "../src/patcher.js";

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
			thinkingLevelMap: m.thinkingLevelMap,
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
	pi.on("session_start", async (_event, ctx) => {
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
		// Decide the pi.invokeTool patch + MCP tool bridge path. The patch is only
		// needed for the bridge; the provider and AskAntigravity tool always work.
		// The bridge can only start when the patch is LIVE in this process; a
		// just-applied patch needs a full pi restart (not /reload) to go live.
		const live = hasInvokeTool(pi);
		const action = live
			? ({ kind: "proceed" } as const)
			: decidePatchAction(live, patchStatus().present, !!loadConfig().invokeToolPatchDeclined, !!ctx.hasUI);

		try {
			switch (action.kind) {
				case "proceed": {
					if (loadConfig().invokeToolPatchDeclined) {
						saveConfig({ invokeToolPatchDeclined: false });
					}
					break;
				}
				case "notify-restart": {
					ctx.ui.notify(
						"The pi.invokeTool patch is present on disk but not loaded in this pi session. Fully RESTART pi (quit + relaunch) to start the MCP tool bridge.",
						"warning",
					);
					break;
				}
				case "silent": {
					// Previously declined. Stay quiet; bridge stays off until the user
					// runs /agy patch apply or the patch becomes live.
					mcpLog("patch-declined");
					break;
				}
				case "ask": {
					const apply = await ctx.ui.confirm(
						"Apply the pi.invokeTool patch?",
						"Enables the MCP tool bridge. Edits one method into your installed @earendil-works/pi-coding-agent/dist/ (reversible via /agy patch restore), and takes effect after a full pi restart.",
						// Bound the wait so a non-confirm-capable RPC client (hasUI is always
						// true in RPC) can't hang session_start. Timeout resolves like "no"
						// (declined persists); reversible via /agy patch apply.
						{ timeout: 60_000 },
					);
					if (apply) {
						const res = applyInvokeToolPatch({ log: mcpLog });
						if (res.patched) {
							saveConfig({ invokeToolPatchDeclined: false });
							ctx.ui.notify(
								`Applied the pi.invokeTool patch to ${res.root} (pi ${res.version}). Fully RESTART pi (quit + relaunch) to start the MCP tool bridge.`,
								"warning",
							);
						} else if (res.errors.length > 0) {
							ctx.ui.notify(`pi.invokeTool patch failed: ${res.errors[0]}`, "error");
						}
					} else {
						saveConfig({ invokeToolPatchDeclined: true });
						ctx.ui.notify(
							"Skipped. The MCP tool bridge stays off. To enable it later, run /agy patch apply. Then restart pi.",
							"info",
						);
					}
					break;
				}
				case "headless-skip": {
					console.error(
						"[antigravity-bridge] pi.invokeTool patch missing; MCP tool bridge off. Apply interactively (/agy patch apply) or re-run pi in a TUI.",
					);
					break;
				}
			}
		} catch (e) {
			mcpLog("self-patch-error", e instanceof Error ? e.message : String(e));
		}

		if (action.kind !== "proceed") return; // bridge can't start without a live patch
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
		`  tool model:    ${config.defaultModel}`,
		`  tool thinking: ${config.defaultThinking}`,
		`  sessions:      ${ctx.store.size} bound`,
		`  config:        ${CONFIG_PATH}`,
		`  invokeTool:    ${patchStateLabel()}`,
		"",
		"Subcommands: /agy mode plan|accept-edits, /agy permissions on|off, /agy model flash|pro|gemini, /agy thinking low|medium|high, /agy patch status|apply|restore, /agy clear",
	].join("\n");
}

function patchStateLabel(): string {
	const s = patchStatus();
	if (s.present) return "patched";
	if (!s.root) return "MISSING (pi root not found)";
	if (loadConfig().invokeToolPatchDeclined) return `declined (pi ${s.version}). Resume: /agy patch apply`;
	return `MISSING (pi ${s.version}). Apply it: /agy patch apply`;
}

function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity provider: status, mode picker, patch, clear sessions. Usage: /agy [status|mode [plan|accept-edits]|patch [status|apply|restore]|clear]",
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

			if (sub === "patch") {
				if (val === "restore") {
					const r = restorePatch();
					ui?.notify(
						r.ok
							? `Restored ${r.restoredFiles.length} file(s) from ${r.backupDir}. Restart pi to take effect.`
							: `restore failed: ${r.reason}`,
						r.ok ? "info" : "error",
					);
					return;
				}
				if (val === "apply") {
					const r = applyInvokeToolPatch();
					if (r.patched || r.alreadyPresent) {
						saveConfig({ invokeToolPatchDeclined: false });
					}
					const msg = r.patched
						? `Applied patch to ${r.changedFiles.length} file(s) in ${r.root} (pi ${r.version}). Restart pi to activate.`
						: r.alreadyPresent
							? `Patch already present in ${r.root} (pi ${r.version}).`
							: `apply failed: ${r.errors[0] ?? "unknown error"}`;
					ui?.notify(msg, r.patched || r.alreadyPresent ? "info" : "error");
					return;
				}
				// status (default)
				const s = patchStatus();
				if (!s.root) {
					ui?.notify("patch status: could not locate the pi package root.", "warning");
				} else {
					ui?.notify(
						[
							`pi.invokeTool patch: ${s.present ? "PRESENT" : "MISSING"}`,
							`  root:    ${s.root}`,
							`  version: ${s.version}`,
							s.missing.length ? `  missing: ${s.missing.length} site(s)` : null,
							loadConfig().invokeToolPatchDeclined ? "  consent: declined. Resume: /agy patch apply" : null,
						s.backupDir ? `  backup:  ${s.backupDir} (v${s.backupVersion})` : "  backup:  none",
							"",
							"Usage: /agy patch [status|apply|restore]",
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
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
