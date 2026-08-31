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

export type AgyMode = "accept-edits" | "plan";
export type ThinkingTier = "low" | "medium" | "high";
export type AgyEngine = "stream-json" | "legacy-sqlite";
export type BridgeTools = "none" | "mcp" | "all";

export interface AgyConfig {
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
	/** Turn engine. "stream-json" (default): one persistent agy process fed
	 *  NDJSON user events; enables live toolUse round-trips, native usage, and
	 *  conversation binding from the init event. "legacy-sqlite": the old
	 *  spawn-`agy -p`-and-poll-SQLite path, kept as a fallback for one release. */
	engine: AgyEngine;
	/** Which pi tools the MCP bridge exposes to agy: "none" (bridge off),
	 *  "mcp" (pi-mcp-adapter tools + skills bridge; default), "all" (every
	 *  registered non-builtin tool incl. other Ask* delegations). */
	bridgeTools: BridgeTools;
}

const DEFAULTS: AgyConfig = {
	mode: "accept-edits",
	skipPermissions: true,
	defaultModel: "flash",
	defaultThinking: "medium",
	engine: "stream-json",
	bridgeTools: "mcp",
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

	// Env overrides file (matches the skipPermissions pattern).
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

	const engine: AgyEngine =
		process.env.AGY_ENGINE === "legacy-sqlite" || file.engine === "legacy-sqlite"
			? "legacy-sqlite"
			: "stream-json";

	const bridgeRaw = (process.env.AGY_BRIDGE_TOOLS ?? file.bridgeTools ?? DEFAULTS.bridgeTools).toLowerCase();
	const bridgeTools: BridgeTools =
		bridgeRaw === "none" || bridgeRaw === "all" ? bridgeRaw : "mcp";

	return { mode, skipPermissions, defaultModel, defaultThinking, engine, bridgeTools };
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
