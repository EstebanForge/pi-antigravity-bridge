// The AskAntigravity tool: delegate a self-contained sub-task to Google
// Antigravity's `agy` CLI. Ported from pi-ask-antigravity v1.1.0 so this
// extension (pi-antigravity-bridge) provides BOTH the streaming provider AND
// the one-shot delegation tool - the same shape as pi-claude-bridge.
//
// One self-contained tool. Spawns `agy -p`, streams its stdout as partial
// output, returns the final response. agy runs its OWN tool loop (read,
// write, edit, exec) inside the workspace.
//
// When both pi-antigravity-bridge and pi-ask-antigravity are installed, the
// bridge wins: pi-ask-antigravity detects the bridge package and registers
// nothing (see its defer guard). This module is the single source of truth.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CONVERSATIONS_DIR,
	newConversationId,
	snapshotConversations,
} from "./discovery.js";
import { loadConfig, type AgyMode, type ThinkingTier } from "./config.js";
import { spawnAgyModelsRaw } from "./models.js";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;

// Per-family fallback tier when none is specified and no config default.
const FAMILY_DEFAULT_TIER: Record<Family, ThinkingTier> = {
	flash: "medium",
	pro: "high",
	other: "medium",
};
const TIER_RANK: Record<ThinkingTier, number> = { low: 0, medium: 1, high: 2 };

// Static alias overlay for non-Gemini models agy may or may not surface.
// Live catalog entries win on case-insensitive full-string equality; the
// overlay resolves the alias when agy doesn't list it. Names are agy's stable
// slugs (the same ids `agy models` prints and `--model` accepts).
const STATIC_ALIAS_OVERLAY: ReadonlyArray<ModelEntry> = [
	{ full: "claude-sonnet-4-6", family: "other", version: null, tier: null },
	{ full: "claude-opus-4-6-thinking", family: "other", version: null, tier: null },
	{ full: "gpt-oss-120b-medium", family: "other", version: null, tier: null },
];
const STATIC_SHORT_ALIAS: ReadonlyMap<string, string> = new Map([
	["sonnet", "claude-sonnet-4-6"],
	["opus", "claude-opus-4-6-thinking"],
	["gpt-oss", "gpt-oss-120b-medium"],
]);

// agy conversation ids are UUID DB-stems. First char must be alphanumeric so a
// leading-dash value can't misbind on agy's arg parser; hyphens allowed in the
// body (real UUIDs contain them).
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact.

EXECUTION MODES (param: mode):
- **plan**: agy reviews and plans without writing. Use for cross-review and read-only tasks.
- **accept-edits** (default): agy applies edits directly inside the workspace.

COMPACT OUTPUT (param: digest): when true, the prompt is prefixed to request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.`;

// --- Types -----------------------------------------------------------------

type Family = "flash" | "pro" | "other";

interface ModelEntry {
	full: string; // exact agy slug, e.g. "gemini-3.6-flash-medium"
	family: Family;
	version: string | null; // "3.6"
	tier: ThinkingTier | null;
}

// --- Version helpers -------------------------------------------------------

/** Descending numeric version compare (3.10 > 3.9, not lexical). */
function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da;
	}
	return 0;
}

// --- Model catalog ---------------------------------------------------------

function mergeCatalog(live: ModelEntry[]): ModelEntry[] {
	const seen = new Set(live.map((e) => e.full.toLowerCase()));
	const merged = [...live];
	for (const entry of STATIC_ALIAS_OVERLAY) {
		if (!seen.has(entry.full.toLowerCase())) merged.push(entry);
	}
	return merged;
}

function parseModelLine(line: string): ModelEntry | null {
	const full = line.trim();
	if (!full) return null;
	const lower = full.toLowerCase();
	const family: Family = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: "other";
	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;
	const tierMatch = lower.match(/-(low|medium|high)$/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;
	return { full, family, version, tier };
}

function nearestTier(available: ThinkingTier[], preferred: ThinkingTier): ThinkingTier {
	if (available.includes(preferred)) return preferred;
	const sorted = [...available].sort((a, b) => {
		const da = Math.abs(TIER_RANK[a] - TIER_RANK[preferred]);
		const db = Math.abs(TIER_RANK[b] - TIER_RANK[preferred]);
		return da !== db ? da - db : TIER_RANK[b] - TIER_RANK[a];
	});
	return sorted[0] ?? preferred;
}

/** Resolve a friendly alias / partial name to an exact agy model string. */
export function resolveModel(
	input: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
): string | null {
	const lower = input.toLowerCase().trim();

	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return exact.full;

	if (STATIC_SHORT_ALIAS.has(lower)) {
		const target = STATIC_SHORT_ALIAS.get(lower) as string;
		const fromCatalog = entries.find((e) => e.full.toLowerCase() === target.toLowerCase());
		return fromCatalog ? fromCatalog.full : target;
	}

	let family: Family | null = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: null;
	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;
	const tierMatch = lower.match(/\b(low|medium|high)\b/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	if (!family && (/gemini/.test(lower) || lower === "" || lower === "default")) {
		family = "flash";
	}
	if (!family) return null;

	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) return null;

	if (version) {
		const versioned = candidates.filter((e) => e.version === version);
		if (versioned.length > 0) candidates = versioned;
	} else {
		const aliases = candidates.filter((e) => e.version === null);
		if (aliases.length > 0) {
			candidates = aliases;
		} else {
			const versions = candidates
				.map((e) => e.version)
				.filter((v): v is string => v !== null)
				.sort(compareVersionsDesc);
			if (versions.length > 0) {
				const top = versions[0];
				const latest = candidates.filter((e) => e.version === top);
				if (latest.length > 0) candidates = latest;
			}
		}
	}

	const familyTiers = new Set(
		candidates.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null),
	);
	if (familyTiers.size === 0) return candidates[0].full;

	const preferred =
		tier ??
		(familyTiers.has(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER[family]);
	const chosenTier = nearestTier([...familyTiers], preferred);
	return (candidates.find((e) => e.tier === chosenTier) ?? candidates[0]).full;
}

/** Parse raw `agy models` text into tool-catalog entries (all families, plus
 *  the static sonnet/opus/gpt-oss overlay). Pure: no spawn. */
export function toolModelsFromRaw(raw: string): ModelEntry[] {
	return mergeCatalog(
		raw.split("\n").map(parseModelLine).filter((e): e is ModelEntry => e !== null),
	);
}

/** Query `agy models` and return tool-catalog entries. Returns [] on failure.
 *  Kept for standalone use; the extension entry spawns once and parses via
 *  toolModelsFromRaw to avoid a second `agy models` invocation. */
export async function discoverToolModels(binary: string): Promise<ModelEntry[]> {
	return toolModelsFromRaw(await spawnAgyModelsRaw(binary));
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Registration ----------------------------------------------------------

/** Register the AskAntigravity tool. Call once from the extension entry.
 *  `entries` is the merged live+overlay catalog discovered at load. */
export async function registerAskAntigravityTool(
	pi: ExtensionAPI,
	entries: ModelEntry[],
): Promise<void> {
	pi.registerTool({
		name: "AskAntigravity",
		label: "Ask Antigravity",
		description: AGY_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for agy. Include all context agy needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path agy runs in. Defaults to the current project root.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model alias or exact id. Friendly: 'flash', 'pro', 'gemini'. Add a tier: 'flash high'. Pin a version: '3.5 flash'. Exact: 'gemini-3.6-flash-medium'. Omit for the configured default.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("plan"), Type.Literal("accept-edits")], {
					description:
						"agy execution mode. 'plan' = review-only. 'accept-edits' = agy applies edits (default).",
					default: "accept-edits",
				}),
			),
			digest: Type.Optional(
				Type.Boolean({
					description:
						"Request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.",
				}),
			),
			conversationId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot. To CONTINUE a previous agy conversation, pass the conversationId returned in that call's details.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({ description: `Hard cap on the agy run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.` }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard: refuse if already running through the
			// antigravity provider.
			if (ctx.model?.provider === "antigravity" || ctx.model?.provider === "agy") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskAntigravity cannot be used when the active provider is already antigravity - you're already running through it.",
						},
					],
					details: emptyDetails(),
				};
			}

			const config = loadConfig();
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" - not a valid model id.`,
						},
					],
					details: emptyDetails(requestedModel),
				};
			}
			const resolved =
				resolveModel(requestedModel, entries, config.defaultThinking) ?? requestedModel;

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: emptyDetails(requestedModel, resolved),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: emptyDetails(requestedModel, resolved),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			const rawConvId = params.conversationId;
			const isContinuation =
				typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
			const snapshot = isContinuation ? null : snapshotConversations();

			const mode: AgyMode = (params.mode as AgyMode | undefined) ?? "accept-edits";
			const useDigest: boolean =
				typeof params.digest === "boolean" ? params.digest : mode === "plan";
			const finalPrompt: string = useDigest
				? `(Use compact digests, not full file contents.)\n${params.prompt}`
				: params.prompt;

			const args: string[] = ["--add-dir", cwd];
			const extra = extraArgs();
			if (extra.length) args.push(...extra);
			if (resolved) args.push("--model", resolved);
			args.push("--mode", mode);
			// Honor the shared permissions setting (same knob as the provider). Non-
			// interactive -p can't answer a permission prompt, so when this is off
			// any run_command will hang - but the setting must mean what it says.
			if (config.skipPermissions !== false) args.push("--dangerously-skip-permissions");
			if (isContinuation) args.push("--conversation", rawConvId as string);
			args.push("--print-timeout", `${timeoutMin}m`);
			args.push("-p", finalPrompt);

			const details: AgyDetails = {
				model: requestedModel,
				resolvedModel: resolved,
				mode,
				digest: useDigest,
				conversationId: isContinuation ? (rawConvId as string) : null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				stderr: "",
			};

			const binary = process.env.AGY_BIN || "agy";
			let out = "";

			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = out.slice(-STATUS_TAIL_CHARS);
						const text = tail ? `(running ${elapsed}s)\n…${tail}` : `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			try {
				// Bind the conversation id DURING the run (agy is alive then) so the
				// pid-based /proc FD resolver can disambiguate when a concurrent agy
				// also drops a new .db. Awaited after the run; the post-exit loop
				// below is the fallback for runs that exit before the poll binds.
				let bindDuringRun: Promise<void> = Promise.resolve();
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					const proc = spawn(binary, args, {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
						detached: true,
					});
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");
					proc.stdout?.on("data", (d: string) => (out += d));
					proc.stderr?.on("data", (d: string) => (details.stderr += d));

					// Concurrent bind: poll for the new id while agy is alive. The FD
					// resolver needs a live process tree, so this stops (and the post-
					// exit fallback below takes over) once agy has exited.
					if (!isContinuation && snapshot && proc.pid) {
						bindDuringRun = (async () => {
							for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
								if (details.conversationId) return;
								if (proc.exitCode !== null) return; // agy gone: scan useless now
								const found = newConversationId(CONVERSATIONS_DIR, snapshot, {
									pid: proc.pid,
								});
								if (found) {
									details.conversationId = found;
									return;
								}
								await sleep(DISCOVERY_POLL_MS);
							}
						})().catch(() => {
							/* best-effort: a bind error must never fail an otherwise-OK turn */
						});
					}

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {
							/* process group already gone */
						}
						if (!sigkillTimer) {
							sigkillTimer = setTimeout(() => {
								try {
									if (proc.pid) process.kill(-proc.pid, "SIGKILL");
								} catch {
									/* give up */
								}
							}, GRACE_AFTER_TIMEOUT_MS);
						}
					};

					const cleanup = () => {
						if (watchdog) clearTimeout(watchdog);
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
					};
					const onAbort = () => killTree();

					watchdog = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMin * 60_000);

					if (signal) {
						if (signal.aborted) killTree();
						else signal.addEventListener("abort", onAbort, { once: true });
					}

					const finish = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolveP({
							exitCode: code ?? 0,
							aborted: !!signal?.aborted,
							timedOut,
						});
					};

					proc.on("error", (err) => {
						cleanup();
						rejectP(err);
					});
					proc.on("close", finish);
					proc.on("exit", finish);
				});

				if (statusInterval) clearInterval(statusInterval);

				// Let the during-run bind poll finish (it bails immediately once agy
				// has exited, so this rarely blocks).
				await bindDuringRun;

				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				if (!isContinuation && !details.conversationId && snapshot) {
					for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
						const found = newConversationId(CONVERSATIONS_DIR, snapshot);
						if (found) {
							details.conversationId = found;
							break;
						}
						await sleep(DISCOVERY_POLL_MS);
					}
				}

				const text = out.trim();

				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text
									? `agy was aborted. Partial output:\n\n${text}`
									: "agy was aborted before producing output.",
							},
						],
						details,
					};
				}

				if (outcome.timedOut) {
					const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				if (outcome.exitCode !== 0) {
					const note = details.stderr.trim()
						? `agy exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
						: `agy exited with status ${outcome.exitCode}`;
					return {
						content: [{ type: "text", text: text ? `${text}\n\n[${note}]` : note }],
						details,
					};
				}

				onUpdate?.({ content: [{ type: "text", text: "" }], details: { ...details } });
				const footer = details.conversationId
					? `\n\n[agy conversationId: ${details.conversationId} - pass as conversationId to continue this conversation]`
					: "";
				return { content: [{ type: "text", text: text + footer }], details };
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `failed to run agy: ${msg}` }], details };
			}
		},
	});
}

interface AgyDetails {
	model: string | null;
	resolvedModel: string | null;
	mode: AgyMode;
	digest: boolean;
	conversationId: string | null;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	durationMs: number;
	stderr: string;
}

function emptyDetails(model: string | null = null, resolvedModel: string | null = null): AgyDetails {
	return {
		model,
		resolvedModel,
		mode: "accept-edits",
		digest: false,
		conversationId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		stderr: "",
	};
}
