// Runtime config for the antigravity provider. Persisted at
// ~/.pi/agent/antigravity-bridge/config.json so the /agy command can
// toggle settings that take effect on the next turn.
//
// Two knobs today:
//   mode            "accept-edits" (default) or "plan". Drives agy's --mode.
//   filterNarration true (default). Drops agy's "I will ..." planning chunks
//                   so the streamed transcript reads as prose, not narration.
//
// Env overrides (AGY_MODE, AGY_FILTER_NARRATION) win over the file so tests
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

export type AgyMode = "accept-edits" | "plan";
export type ThinkingTier = "low" | "medium" | "high";

export interface AgyConfig {
	mode: AgyMode;
	filterNarration: boolean;
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
	/** User declined the pi.invokeTool auto-patch consent prompt. When true,
	 *  session_start silently skips the patch + MCP tool bridge until cleared
	 *  (by /agy patch apply succeeding, or the patch otherwise becoming live). */
	invokeToolPatchDeclined?: boolean;
}

const DEFAULTS: AgyConfig = {
	mode: "accept-edits",
	filterNarration: true,
	skipPermissions: true,
	defaultModel: "flash",
	defaultThinking: "medium",
};

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

	// Env overrides file (matches the filterNarration/skipPermissions pattern).
	// The naive OR `env === "plan" || file.mode === "plan"` would ignore an
	// explicit AGY_MODE=accept-edits when the file says plan, violating the
	// documented precedence. Check env first.
	const mode: AgyMode =
		process.env.AGY_MODE !== undefined
			? process.env.AGY_MODE === "plan"
				? "plan"
				: "accept-edits"
			: file.mode === "plan"
				? "plan"
				: "accept-edits";

	const envFlag = process.env.AGY_FILTER_NARRATION;
	const filterNarration =
		envFlag !== undefined
			? envFlag === "1" || envFlag.toLowerCase() === "true"
			: file.filterNarration ?? DEFAULTS.filterNarration;

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

	return { mode, filterNarration, skipPermissions, defaultModel, defaultThinking, invokeToolPatchDeclined: file.invokeToolPatchDeclined };
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
