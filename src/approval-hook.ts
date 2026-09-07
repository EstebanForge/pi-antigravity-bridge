// Staging for the approval-gate hooks.json (docs/TODO.md 2.5).
//
// The ACP server and the agy CLI fire workspace `.agents/hooks.json`
// PreToolUse hooks (V2: deny honored, reason reaches the model; V3: hook
// TIMEOUT = soft-pass, agy proceeds ungated). Therefore:
//   - the staged handler timeout must exceed the whole park budget with
//     margin (never rely on timeout as a deny), and
//   - the staged command delegates to the bundled poll script, which
//     early-acks and polls the bridge for the terminal decision.
//
// Merge rules: never clobber a foreign hooks.json. Parse failures abort
// staging; first-time modification of an existing file writes a
// timestamped backup next to it (the 2026-09-05 incident rule: every
// destructive path gets a guard).
//
// Run: npm test

import fs from "node:fs";
import path from "node:path";

export const HOOK_GROUP = "pi-bridge-gate";

/** agy native tools worth gating: everything that mutates the machine. */
export const GATED_AGY_TOOLS =
	"create_file|write_to_file|replace_file_content|multi_replace_file_content|edit_file|run_command";

export interface StageOptions {
	/** Bridge HTTP port (the approval endpoints live on the bridge server). */
	port: number;
	/** Bridge shared secret (x-bridge-token). */
	token: string;
	/** Path to the bundled poll script (written by the caller). */
	scriptPath: string;
	/** Full park budget in ms; the staged hook timeout exceeds it. */
	parkBudgetMs: number;
}

/** Source of the staged poll script. Written to disk by the caller (data
 *  dir), referenced by absolute path from the staged hooks.json. Early-acks
 *  via POST /approval, then polls GET /approval/<ticket> until a terminal
 *  decision or the deadline. Terminal: prints the JSON decision on stdout.
 *  Deadline hit: prints {"decision":"deny", ...} (fail closed) - agy may
 *  still soft-pass a timed-out hook, but a printed deny is honored (V2). */
export function hookScriptSource(opts: { port: number; token: string; deadlineMs: number }): string {
	return `#!/usr/bin/env node
// Bridge approval hook (generated; do not edit). Polls the pi-antigravity-bridge.
const PORT = ${opts.port};
const TOKEN = ${JSON.stringify(opts.token)};
const DEADLINE = Date.now() + ${opts.deadlineMs};
let body = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) body += chunk;
let ticket = "";
try {
	const res = await fetch(\`http://127.0.0.1:\${PORT}/approval\`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-bridge-token": TOKEN },
		body,
	});
	const json = await res.json();
	ticket = json.ticket ?? "";
} catch {}
if (!ticket) {
	console.log(JSON.stringify({ decision: "deny", reason: "approval gate unreachable (bridge down?)" }));
	process.exit(0);
}
while (Date.now() < DEADLINE) {
	await new Promise((r) => setTimeout(r, 500));
	try {
		const res = await fetch(\`http://127.0.0.1:\${PORT}/approval/\${encodeURIComponent(ticket)}\`, {
			headers: { "x-bridge-token": TOKEN },
		});
		const json = await res.json();
		if (json.status !== "pending") {
			console.log(JSON.stringify(json.decision ?? { decision: "deny", reason: "gate returned no decision" }));
			process.exit(0);
		}
	} catch {}
}
console.log(JSON.stringify({ decision: "deny", reason: "approval gate deadline exceeded" }));
`;
}

/** Hook timeout (seconds) staged for a given park budget: the budget plus a
 *  60s margin, minimum 60s. V3: a timed-out hook soft-passes, so this must
 *  never be smaller than the human can plausibly need. */
export function stagedTimeoutSeconds(parkBudgetMs: number): number {
	return Math.max(60, Math.ceil(parkBudgetMs / 1000) + 60);
}

/** Build our hooks.json group for one workspace staging. */
export function buildGateGroup(opts: StageOptions): Record<string, unknown> {
	const command = `node ${JSON.stringify(opts.scriptPath)}`;
	return {
		enabled: true,
		PreToolUse: [
			{
				matcher: GATED_AGY_TOOLS,
				hooks: [
					{
						type: "command",
						command,
						timeout: stagedTimeoutSeconds(opts.parkBudgetMs),
					},
				],
			},
		],
	};
}

export interface StageResult {
	wrote: boolean;
	/** Backup file written before first modification of a foreign file. */
	backup?: string;
	/** Why nothing was written (parse failure, already current, ...). */
	reason?: string;
}

/** Stage the gate group into <workspaceDir>/.agents/hooks.json. Merge-safe:
 *  foreign groups are preserved; a foreign file is backed up before its
 *  first modification; unparseable files are never touched. */
export function stageGateHooks(workspaceDir: string, opts: StageOptions): StageResult {
	const dir = path.join(workspaceDir, ".agents");
	const file = path.join(dir, "hooks.json");
	const group = buildGateGroup(opts);
	let current: Record<string, unknown> = {};
	const existed = fs.existsSync(file);
	if (existed) {
		try {
			if (fs.lstatSync(file).isSymbolicLink()) {
				return { wrote: false, reason: "hooks.json is a symlink; refusing to follow it" };
			}
		} catch {
			return { wrote: false, reason: "hooks.json vanished while staging" };
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { wrote: false, reason: "hooks.json is not an object; refusing to touch it" };
			}
			current = parsed as Record<string, unknown>;
		} catch {
			return { wrote: false, reason: "hooks.json is not valid JSON; refusing to touch it" };
		}
		if (JSON.stringify(current[HOOK_GROUP]) === JSON.stringify(group)) {
			return { wrote: false, reason: "already staged" };
		}
	}
	const backup =
		existed && current[HOOK_GROUP] === undefined
			? `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
			: undefined;
	if (backup) fs.copyFileSync(file, backup);
	current[HOOK_GROUP] = group;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
	return { wrote: true, backup };
}

/** Remove our group from <workspaceDir>/.agents/hooks.json. Foreign content
 *  stays; an empty object file is left in place (harmless). */
export function removeGateHooks(workspaceDir: string): StageResult {
	const file = path.join(workspaceDir, ".agents", "hooks.json");
	if (!fs.existsSync(file)) return { wrote: false, reason: "no hooks.json" };
	try {
		if (fs.lstatSync(file).isSymbolicLink()) {
			return { wrote: false, reason: "hooks.json is a symlink; refusing to follow it" };
		}
	} catch {
		return { wrote: false, reason: "hooks.json vanished while removing" };
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return { wrote: false, reason: "not an object; refusing" };
		if (parsed[HOOK_GROUP] === undefined) return { wrote: false, reason: "not staged" };
		delete parsed[HOOK_GROUP];
		fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
		return { wrote: true };
	} catch {
		return { wrote: false, reason: "not valid JSON; refusing" };
	}
}
