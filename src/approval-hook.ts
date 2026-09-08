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

/** Group-key namespace. Each pi session stages its OWN group keyed per-pid
 *  (`pi-bridge-gate-<pid>`): hooks.json lives in the SHARED workspace, and
 *  two concurrent sessions must never remove or overwrite each other's gate
 *  (audit 2026-09-07: a single shared key let a gate-off session silently
 *  strip a gate-on session's PreToolUse matchers). */
export const GATE_GROUP_PREFIX = "pi-bridge-gate";

/** This session's group key. */
export function gateGroupKey(pid: number = process.pid): string {
	return `${GATE_GROUP_PREFIX}-${pid}`;
}

/** True if the process is running (EPERM counts: alive but not ours). */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Which session a gate group belongs to, parsed from the script path its
 *  command embeds (`.../approval-hook-<pid>.js`). The pid is the ownership
 *  proof: the script is per-pid (0600, written by that session). Returns
 *  null for groups we cannot attribute (foreign/future formats - never
 *  touched). */
function gateGroupPid(group: unknown): number | null {
	const m = /approval-hook-(\d+)\.js/.exec(JSON.stringify(group));
	return m ? Number(m[1]) : null;
}

/** agy native tools worth gating: everything that mutates the machine. */
export const GATED_AGY_TOOLS =
	"create_file|write_to_file|replace_file_content|multi_replace_file_content|edit_file|run_command";

/** The same list as a set, for the bridge's POST /approval validation: a
 *  payload for anything else is answered with a direct deny (defense in
 *  depth - the hooks matcher should never let one through). */
export const GATED_AGY_TOOL_SET: ReadonlySet<string> = new Set(GATED_AGY_TOOLS.split("|"));

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
	// Ungated payloads get a terminal decision right on the POST (no park).
	if (json && typeof json === "object" && "decision" in json) {
		console.log(JSON.stringify(json.decision));
		process.exit(0);
	}
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

/** Stage the gate group into <workspaceDir>/.agents/hooks.json under THIS
 *  session's per-pid key. Merge-safe:
 *  - foreign groups are preserved;
 *  - gate groups of DEAD sessions are swept (their bridge is gone; the hook
 *    would fail closed forever), groups of live sessions never touched;
 *  - a foreign file is backed up before its first modification;
 *  - unparseable files are never touched. */
export function stageGateHooks(workspaceDir: string, opts: StageOptions): StageResult {
	const dir = path.join(workspaceDir, ".agents");
	const file = path.join(dir, "hooks.json");
	const group = buildGateGroup(opts);
	const ownKey = gateGroupKey();
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
		// Sweep gate groups whose owning session is gone. Never touch groups of
		// live sessions (concurrent pi sessions share this workspace) or groups
		// we cannot attribute.
		let swept = 0;
		for (const key of Object.keys(current)) {
			if (key === ownKey) continue;
			const isGateGroup = key === GATE_GROUP_PREFIX || key.startsWith(`${GATE_GROUP_PREFIX}-`);
			if (!isGateGroup) continue;
			const pid = gateGroupPid(current[key]);
			if (pid === null || pidAlive(pid)) continue;
			delete current[key];
			swept += 1;
		}
		if (swept > 0 && JSON.stringify(current[ownKey]) === JSON.stringify(group)) {
			// Own group already current; the pass only swept dead peers.
			fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
			return { wrote: true, reason: `swept ${swept} dead gate group(s)` };
		}
		if (JSON.stringify(current[ownKey]) === JSON.stringify(group)) {
			return { wrote: false, reason: "already staged" };
		}
	}
	const backup =
		existed && current[ownKey] === undefined
			? `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
			: undefined;
	if (backup) fs.copyFileSync(file, backup);
	current[ownKey] = group;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
	return { wrote: true, backup };
}

/** Remove ONLY this session's gate group (or the given pid's). Other
 *  sessions' groups - including live ones in a shared workspace - are never
 *  touched: a gate-off session must not strip a gate-on session's matchers
 *  (audit 2026-09-07). Foreign content stays; an object file is left in
 *  place (harmless). */
export function removeGateHooks(workspaceDir: string, pid: number = process.pid): StageResult {
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
		const ownKey = gateGroupKey(pid);
		if (parsed[ownKey] === undefined) return { wrote: false, reason: "not staged" };
		delete parsed[ownKey];
		fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
		return { wrote: true };
	} catch {
		return { wrote: false, reason: "not valid JSON; refusing" };
	}
}
