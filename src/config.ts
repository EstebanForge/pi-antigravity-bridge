// Runtime config for the antigravity provider. Persisted at
// ~/.pi/agent/antigravity-bridge/config.json so the /agy command can
// toggle settings that take effect on the next turn.
//
// Knobs today:
//   mode            "accept-edits" (default) or "plan". Drives agy's --mode.
//   skipPermissions true (default). Passes --dangerously-skip-permissions so
//                   commands don't hang on an unanswerable prompt in -p mode.
//
// Env overrides (AGY_MODE, AGY_SKIP_PERMISSIONS) win over the file so tests
// and one-off runs can force a setting without editing the file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"antigravity-bridge",
	"config.json",
);

/** Daily debug logs land here, sorted by day, for post-mortems and user
 *  support (see src/daily-log.ts). Same homedir convention as CONFIG_PATH;
 *  lives under the scoped extensions-data convention shared with other
 *  EstebanForge extensions. */
export function logsDir(): string {
	return path.join(
		os.homedir(),
		".pi",
		"extensions-data",
		"estebanforge",
		"pi-antigravity-bridge",
		"logs",
	);
}

/** Which turn engine drives turns. "stream-json" is the tested default;
 *  "acp" is the official-server engine, opt-in (plan §9.5). */
export type Engine = "stream-json" | "acp";
export type AgyMode = "accept-edits" | "plan";
export type ThinkingTier = "low" | "medium" | "high";
export type BridgeTools = "none" | "mcp" | "all";

/** How ACP turns report token usage while Gate B stands (agy sends none).
 *  "estimate" (default): word-boundary regex over prompt/response/thought
 *  text (pi-token-speed's mechanism). "direct": 1 token per streamed delta.
 *  "off": keep zero-usage. Real server usage (usageSeen latch) always wins. */
export type UsageEstimate = "estimate" | "direct" | "off";

/** How the approval gate activates (docs/TODO.md section 2.5).
 *
 *  "auto" (default): OFF until a third-party pi permission extension is
 *  detected (src/approval-detect.ts). When one is found, the gate runs in
 *  "shadow" mode so that extension gates agy's native tool calls with zero
 *  configuration on its side.
 *
 *  "shadow" / "dedicated": force the gate on in that shape. "off": never
 *  gate, even when a permission extension is installed. NOTE: "dedicated"
 *  currently stages the same shadow tools as "shadow" (warn-logged remap);
 *  the explicit antigravity_approve variant is planned - see docs/TODO.md. */
export type GateMode = "auto" | "shadow" | "dedicated" | "off";

/** Fallback decision when no extension blocked a gated call: "ask" uses
 *  ctx.ui.confirm (headless = deny, fail-closed), "allow" auto-approves,
 *  "deny" auto-rejects. */
export type GateAskMode = "ask" | "allow" | "deny";

export interface GateConfig {
	gateMode: GateMode;
	mode: GateAskMode;
}

export interface AcpConfig {
	/** Path to agy_acp_server.par. Empty = env AGY_ACP_BIN > PATH. */
	bin: string;
	/** Single policy today: auto-approve request_permission in-connection
	 *  (parity with skipPermissions). Kept as a key so future policies do not
	 *  change the config shape. */
	permissions: "auto";
	/** Gate B stopgap: client-side token estimates for ACP turns so pi's
	 *  usage surfaces show nonzero numbers. Estimates are labeled as such in
	 *  /agy doctor and auto-disable when the server sends real usage. */
	usageEstimate: UsageEstimate;
}

export interface AgyConfig {
	/** Engine. Switching requires a pi restart (drivers wire at load). */
	engine: Engine;
	/** Official-server ACP engine options (used when engine = "acp"). */
	acp: AcpConfig;
	mode: AgyMode;
	/** Auto-approve all agy tool permission requests (--dangerously-skip-permissions).
	 *  Required for non-interactive use: without it, any `run_command` triggers an
	 *  interactive y/n prompt that hangs forever in `-p` mode. Defaults true.
	 *  DANGEROUS: lets agy run arbitrary commands (including destructive ones)
	 *  without review. Turn off only if you also set mode=plan (no execution). */
	skipPermissions: boolean;
	/** AskAntigravity tool: default model alias (flash/pro/gemini or exact). */
	defaultModel: string;
	/** AskAntigravity tool: default thinking tier when the alias names none. */
	defaultThinking: ThinkingTier;
	/** Register the AskAntigravity one-shot delegation tool. Default on.
	 *  off removes the tool entirely for users who want only the provider
	 *  and models (no delegation tool in the model's window context).
	 *  Takes effect at pi start (or /reload). */
	askTool: boolean;
	/** Set after the one-time notice about a leftover legacy invokeTool patch
	 *  on the installed pi. The notice never repeats; /agy patch-cleanup is
	 *  always available. */
	patchCleanupNotified?: boolean;
	/** Which pi tools the MCP bridge exposes to agy: "none" (bridge off),
	 *  "all" (every registered non-builtin tool incl. other Ask* delegations;
	 *  default - users expect the bridge working out of the box, and the
	 *  "mcp" surface serves an empty catalog on installs without
	 *  pi-mcp-adapter), "mcp" (pi-mcp-adapter tools + skills bridge only). */
	bridgeTools: BridgeTools;
	/** Inject a delta digest of pi-side context (compaction summaries, turns
	 *  handled by other providers or pi's own tools) into each agy prompt.
	 *
	 *  Default OFF. The digest changes every turn, which defeats agy's
	 *  server-side prompt cache: every turn re-bills the full context
	 *  (~25-30k tokens observed). With it off, prompts stay stable and the
	 *  cache hits.
	 *
	 *  Enable when you mix providers in one pi session (Claude turns, pi-side
	 *  tool runs, or a compaction that agy should know about) and you value
	 *  agy seeing that context over the cache re-billing. Pure antigravity
	 *  sessions gain nothing: agy already keeps its own history, and bridge
	 *  round-trips deliver tool results through the bridge, not the digest. */
	digest: boolean;
	/** Prepend pi's composed system prompt (pi tool guidance + the global
	 *  agent-dir AGENTS.md and ancestor AGENTS.md/CLAUDE.md) to the FIRST
	 *  prompt of each fresh agy conversation.
	 *
	 *  Default ON: agy keeps its own history, so the prefix is sent once per
	 *  conversation and stays byte-identical afterwards - agy's server-side
	 *  prompt cache keeps hitting. This is why it is safe here while the G1
	 *  digest (per-turn) is not. Turn off for agy-native behavior (agy's own
	 *  system prompt only). */
	systemPrompt: boolean;
	/** Overall cap on ONE agy turn in minutes, both engines. When it fires, the
	 *  bridge kills the agy process mid-task ("ACP turn exceeded the Xm
	 *  deadline" / "agy exceeded the Xm turn timeout"). The ACP server binary
	 *  exposes no timeout flag of its own (--helpfull: debug/notices only), so
	 *  this bridge cap is the only knob.
	 *
	 *  Default is TTY-aware: 0 (no cap) on an interactive pi - the user aborts
	 *  with Esc and is the better backstop - and 20 on headless runs, where
	 *  nobody can abort and one runaway turn blocks the drivers' serialized
	 *  turn queue. Explicit values opt into the gate: 1..1440 valid, 0
	 *  disables, anything else (garbage, negative, >1440) falls back to the
	 *  TTY-aware default. The inactivity stall guard (5m silence) still bounds
	 *  a hung server either way. Next-turn effect. Env AGY_TURN_TIMEOUT_MIN
	 *  wins over the file. */
	turnTimeoutMin: number;
	/** Silence cap in minutes, both engines: no stream-json stdout / no ACP
	 *  session/update for this long fails the turn as a stall. Default 5;
	 *  0 disables the guard. Next-turn effect.
	 *  Env AGY_INACTIVITY_TIMEOUT_MIN wins over the file. */
	inactivityTimeoutMin: number;
	/** Approval gate over agy NATIVE tool calls (create_file, run_command,
	 *  ...). pi tools agy calls already pass through pi's gates via the G9
	 *  round-trip; this covers the rest. Default auto (off until a
	 *  third-party permission extension is detected). See docs/TODO.md 2.5. */
	approvals: GateConfig;
}

const DEFAULTS: AgyConfig = {
	engine: "stream-json",
	mode: "accept-edits",
	skipPermissions: true,
	defaultModel: "flash",
	defaultThinking: "medium",
	askTool: true,
	bridgeTools: "all",
	digest: false,
	systemPrompt: true,
	turnTimeoutMin: 0, // placeholder: the real default is resolved per loadConfig call (defaultTurnTimeoutMin)
	inactivityTimeoutMin: 5,
	approvals: { gateMode: "auto", mode: "ask" },
	acp: { bin: "", permissions: "auto", usageEstimate: "estimate" },
};

/** Hard ceiling for a free-typed turn cap: one day, in minutes. */
export const MAX_TURN_CAP_MIN = 1440;

/** TTY-aware default for the overall turn cap. An interactive user aborts
 *  with Esc and is the better backstop; the wall clock only earns its keep
 *  where nobody can abort (headless runs: one runaway turn also blocks the
 *  drivers' serialized turn queue). */
export function defaultTurnTimeoutMin(): number {
	return process.stdout.isTTY || process.stdin.isTTY ? 0 : 20;
}

/** Explicit cap minutes: 0 keeps (disable), 1..MAX_TURN_CAP_MIN keeps;
 *  garbage, negative, or out-of-range falls back to the caller's default.
 *  Pass Number.NaN as the fallback to detect rejection via isNaN. */
export function parseCapMinutes(raw: string | number | undefined, fallback: number): number {
	if (raw === undefined || String(raw).trim() === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(n)) return fallback;
	if (n === 0) return 0;
	return n >= 1 && n <= MAX_TURN_CAP_MIN ? n : fallback;
}

/** Load config merged over defaults. Env vars override the file when set. */
export function loadConfig(configPath: string = CONFIG_PATH): AgyConfig {
	let file: Partial<AgyConfig> = {};
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			file = parsed as Partial<AgyConfig>;
		}
	} catch {
		/* missing or corrupt  -  fall back to defaults */
	}

	// Env overrides file (matches the skipPermissions pattern).
	// The naive OR `env === "plan" || file.mode === "plan"` would ignore an
	// explicit AGY_MODE=accept-edits when the file says plan, violating the
	// documented precedence. Check env first.
	// Engine: narrow to the known set; anything else (incl. the pre-1.3.2
	// "sqlite" value) falls back to the tested default.
	const engineRaw = String(process.env.AGY_ENGINE ?? file.engine ?? DEFAULTS.engine).toLowerCase();
	const engine: Engine = engineRaw === "acp" ? "acp" : "stream-json";

	const mode: AgyMode =
		process.env.AGY_MODE !== undefined
			? process.env.AGY_MODE === "plan"
				? "plan"
				: "accept-edits"
			: file.mode === "plan"
				? "plan"
				: "accept-edits";

	const envPerm = process.env.AGY_SKIP_PERMISSIONS;
	const skipPermissions =
		envPerm !== undefined
			? envPerm === "1" || envPerm.toLowerCase() === "true"
			: file.skipPermissions ?? DEFAULTS.skipPermissions;

	const defaultModelRaw =
		process.env.AGY_DEFAULT_MODEL ?? file.defaultModel ?? DEFAULTS.defaultModel;
	const defaultModel =
		typeof defaultModelRaw === "string" ? defaultModelRaw.trim() || DEFAULTS.defaultModel : DEFAULTS.defaultModel;

	const envThink = process.env.AGY_DEFAULT_THINKING;
	const thinkRaw = (envThink ?? file.defaultThinking ?? DEFAULTS.defaultThinking).toLowerCase();
	const defaultThinking: ThinkingTier =
		thinkRaw === "low" || thinkRaw === "high" ? thinkRaw : "medium";

	const askTool = process.env.AGY_ASK_TOOL !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_ASK_TOOL.toLowerCase())
		: file.askTool ?? DEFAULTS.askTool;

	const bridgeRaw = (process.env.AGY_BRIDGE_TOOLS ?? file.bridgeTools ?? DEFAULTS.bridgeTools).toLowerCase();
	const bridgeTools: BridgeTools =
		bridgeRaw === "none" || bridgeRaw === "all" || bridgeRaw === "mcp"
			? bridgeRaw
			: DEFAULTS.bridgeTools;

	const digest = process.env.AGY_DIGEST !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_DIGEST.toLowerCase())
		: file.digest ?? false;

	const envSys = process.env.AGY_SYSTEM_PROMPT;
	const systemPrompt = envSys !== undefined
		? ["1", "true", "on"].includes(envSys.toLowerCase())
		: file.systemPrompt ?? DEFAULTS.systemPrompt;

	// Turn caps, minutes. Env wins over the file (same pattern as mode).
	const turnTimeoutMin = parseCapMinutes(
		process.env.AGY_TURN_TIMEOUT_MIN ?? file.turnTimeoutMin,
		defaultTurnTimeoutMin(),
	);
	const inactivityTimeoutMin = parseCapMinutes(
		process.env.AGY_INACTIVITY_TIMEOUT_MIN ?? file.inactivityTimeoutMin,
		DEFAULTS.inactivityTimeoutMin,
	);

	// Approval gate (docs/TODO.md 2.5). Unknown values fall back to "auto"
	// so a typo can never silently force the gate on.
	const gateRaw = (process.env.AGY_APPROVALS ?? file.approvals?.gateMode ?? DEFAULTS.approvals.gateMode).toLowerCase();
	const gateMode: GateMode =
		gateRaw === "shadow" || gateRaw === "dedicated" || gateRaw === "off"
			? gateRaw
			: "auto";
	const askRaw = (process.env.AGY_APPROVALS_MODE ?? file.approvals?.mode ?? DEFAULTS.approvals.mode).toLowerCase();
	const gateAskMode: GateAskMode =
		askRaw === "allow" || askRaw === "deny"
			? askRaw
			: "ask";

	const fileAcp = (typeof file.acp === "object" && file.acp !== null ? file.acp : {}) as Partial<AcpConfig>;
	// Unknown values fall back to "estimate" (same narrow-parse pattern as
	// gateMode: a typo must never silently change behavior).
	const usageRaw = String(
		process.env.AGY_USAGE_ESTIMATE ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
	).toLowerCase();
	const usageEstimate: UsageEstimate =
		usageRaw === "direct" || usageRaw === "off" ? usageRaw : "estimate";
	const acp: AcpConfig = {
		bin:
			process.env.AGY_ACP_BIN ??
			(typeof fileAcp.bin === "string" ? fileAcp.bin : DEFAULTS.acp.bin),
		permissions: "auto",
		usageEstimate,
	};

	return {
		engine,
		acp,
		mode,
		skipPermissions,
		defaultModel,
		defaultThinking,
		askTool,
		bridgeTools,
		digest,
		systemPrompt,
		turnTimeoutMin,
		inactivityTimeoutMin,
		approvals: { gateMode, mode: gateAskMode },
		patchCleanupNotified: file.patchCleanupNotified === true,
	};
}

/** Atomically persist a config patch (temp + rename). */
export function saveConfig(patch: Partial<AgyConfig>, configPath: string = CONFIG_PATH): AgyConfig {
	const current = loadConfig(configPath);
	const next: AgyConfig = { ...current, ...patch };
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${configPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, configPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		throw err;
	}
	return next;
}

export { CONFIG_PATH };
