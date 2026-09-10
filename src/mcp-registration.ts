// Per-pid bridge registration for the stream-json engine (docs/TODO.md
// section 1, step 2). The stream-json agy CLI discovers MCP servers from
// ~/.gemini/config/mcp_config.json (verified live 2026-09-07: a server
// registered via `agy mcp add --type http` was called by agy through its
// native call_mcp_tool wrapper, exact entry shape captured from agy's own
// writes):
//
//   { "mcpServers": { "<name>": { "disabled": false,
//        "headers": { "x-bridge-token": "..." }, "serverUrl": "http://..." } } }
//
// The ACP engine does not use this file (mcpServers ride session/new).
//
// Merge rules: foreign servers are preserved; corrupt JSON is refused (the
// file is shared user config - never clobber); writes are atomic.
//
// Run: npm test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name convention for the bridge's per-pid server entries. */
export function bridgeServerName(pid: number): string {
	return `pi-bridge-${pid}`;
}

export function mcpConfigPath(home: string = os.homedir()): string {
	return path.join(home, ".gemini", "config", "mcp_config.json");
}

export interface BridgeServerEntry {
	disabled: boolean;
	headers: Record<string, string>;
	serverUrl: string;
}

type McpConfig = { mcpServers: Record<string, unknown> };

function readConfig(file: string): { ok: true; config: McpConfig } | { ok: false; reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, config: { mcpServers: {} } };
		return { ok: false, reason: `mcp_config.json is not valid JSON; refusing to touch it (${String(err)})` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "mcp_config.json is not an object; refusing to touch it" };
	}
	const config = parsed as McpConfig;
	if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
		config.mcpServers = {};
	}
	return { ok: true, config };
}

function writeConfig(file: string, config: McpConfig): void {
	// 0700/0600: the file carries the bridge's shared-secret token in its
	// headers, and it lives in the USER'S global agy config (audit 2026-09-07:
	// it previously landed at the umask default, typically world-readable).
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Register (or refresh) the bridge's per-pid server entry. Foreign servers
 *  in the file are preserved.
 *
 *  One shared guard for delegation isolation: while ANY live delegation is
 *  in flight anywhere on the machine (per the suppression marker), a fresh
 *  registration lands disabled - the delegated agy must not discover a new
 *  bridge mid-run. The last release re-enables every entry again. */
export function registerBridgeServer(
	entry: { pid: number; port: number; token: string; tokenHeader: string },
	configPath: string = mcpConfigPath(),
	opts: {
		markerPath?: string;
		isAlive?: (pid: number) => boolean;
		now?: () => number;
	} = {},
): { wrote: boolean; disabled: boolean; reason?: string } {
	const marker = readSuppressionMarker(opts.markerPath ?? suppressionMarkerPath());
	const disabled = hasLiveDelegator(marker, opts.isAlive ?? pidAlive, (opts.now ?? Date.now)());
	const read = readConfig(configPath);
	if (!read.ok) return { wrote: false, disabled, reason: read.reason };
	read.config.mcpServers[bridgeServerName(entry.pid)] = {
		disabled,
		headers: { [entry.tokenHeader]: entry.token },
		serverUrl: `http://127.0.0.1:${entry.port}/mcp`,
	} satisfies BridgeServerEntry;
	writeConfig(configPath, read.config);
	return { wrote: true, disabled };
}

/** Remove the bridge's per-pid server entry (close path). */
export function unregisterBridgeServer(pid: number, configPath: string = mcpConfigPath()): { wrote: boolean } {
	const read = readConfig(configPath);
	if (!read.ok) return { wrote: false };
	const name = bridgeServerName(pid);
	if (!(name in read.config.mcpServers)) return { wrote: false };
	delete read.config.mcpServers[name];
	writeConfig(configPath, read.config);
	return { wrote: true };
}

/** Flip `disabled` on every pi-bridge-* entry (foreign servers untouched).
 *
 *  (1) Delegation isolation: the global config is read by ANY agy on the
 *  machine, so an `agy -p` we spawn ourselves (AskAntigravity) would discover
 *  live bridge entries and call tools the round-trip store cannot serve
 *  outside a live provider turn (fail-closed "no active antigravity turn",
 *  observed live 2026-09-15). agy reads the config once at startup, so a
 *  short suppression window around the spawn hides the bridge from it.
 *
 *  (2) Startup healing (disabled=false): clears entries a crashed delegation
 *  left suppressed. */
export function setBridgeEntriesDisabled(
	disabled: boolean,
	configPath: string = mcpConfigPath(),
): { wrote: boolean; changed: number; reason?: string } {
	const read = readConfig(configPath);
	if (!read.ok) return { wrote: false, changed: 0, reason: read.reason };
	let changed = 0;
	for (const [name, entry] of Object.entries(read.config.mcpServers)) {
		if (!/^pi-bridge-\d+$/.test(name)) continue;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const e = entry as { disabled?: unknown };
		if ((e.disabled === true) === disabled) continue;
		e.disabled = disabled;
		changed++;
	}
	if (changed === 0) return { wrote: false, changed: 0 };
	writeConfig(configPath, read.config);
	return { wrote: true, changed };
}

// --- Cross-process suppression marker --------------------------------------

/** Shape of the shared delegator marker (suppression.json). Keyed by pi pid;
 *  `since` is the acquire timestamp in ms since epoch. Coordination ONLY:
 *  the disabled flags in mcp_config.json stay the actual gate. */
export interface SuppressionMarker {
	delegators: Record<string, { since: number }>;
}

/** Marker path, mirroring the extensions-data convention (src/config.ts
 *  logsDir). Lives OUTSIDE ~/.gemini so agy's watched config dir stays
 *  untouched. */
export function suppressionMarkerPath(home: string = os.homedir()): string {
	return path.join(
		home,
		".pi",
		"extensions-data",
		"estebanforge",
		"pi-antigravity-bridge",
		"suppression.json",
	);
}

/** A SIGKILLed pi can leave its marker entry behind, and pid reuse could
 *  keep kill(pid,0) answering forever. The age bound caps that wedge: a
 *  delegation never legitimately runs this long, so an entry this old is
 *  dead regardless of what the pid probe says. */
const DELEGATOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readSuppressionMarker(file: string): SuppressionMarker {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { delegators: {} };
		const delegators = (parsed as SuppressionMarker).delegators;
		if (!delegators || typeof delegators !== "object" || Array.isArray(delegators)) {
			return { delegators: {} };
		}
		return { delegators };
	} catch {
		// Missing or corrupt marker: fail-open to empty. Never worse than the
		// pre-marker blind re-enable; the next write replaces the file.
		return { delegators: {} };
	}
}

function writeSuppressionMarker(file: string, marker: SuppressionMarker): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function delegatorLive(pid: string, entry: { since?: number } | undefined, isAlive: (pid: number) => boolean, now: number): boolean {
	const n = Number(pid);
	const since = typeof entry?.since === "number" ? entry.since : 0;
	return Number.isFinite(n) && n > 0 && now - since < DELEGATOR_MAX_AGE_MS && isAlive(n);
}

function pruneDelegators(
	marker: SuppressionMarker,
	isAlive: (pid: number) => boolean,
	now: number,
): { kept: SuppressionMarker; pruned: string[] } {
	const kept: SuppressionMarker = { delegators: {} };
	const pruned: string[] = [];
	for (const [pid, entry] of Object.entries(marker.delegators)) {
		if (delegatorLive(pid, entry, isAlive, now)) kept.delegators[pid] = { since: entry.since };
		else pruned.push(pid);
	}
	return { kept, pruned };
}

function hasLiveDelegator(marker: SuppressionMarker, isAlive: (pid: number) => boolean, now: number): boolean {
	return Object.entries(marker.delegators).some(([pid, entry]) => delegatorLive(pid, entry, isAlive, now));
}

function bestEffortWriteMarker(file: string, marker: SuppressionMarker): void {
	try {
		writeSuppressionMarker(file, marker);
	} catch {
		// Coordination hint only; a failed write must never break a release or
		// a heal. The disabled flags in mcp_config.json remain the gate.
	}
}

const suppressionRefs = new Map<string, number>();

/** Reference-counted suppression for a self-spawned agy process (AskAntigravity
 *  delegation). First acquire disables every pi-bridge-* entry AND records
 *  this process's pid in the shared suppression marker; last release removes
 *  it and re-enables only when no LIVE delegator remains - so two pi sessions
 *  delegating concurrently no longer re-enable each other's entries
 *  (previously a same-process-only refcount raced on the shared file).
 *  Nested acquires in one process are free. Residual race: concurrent
 *  read-modify-write of the marker across processes is last-writer-wins
 *  (atomic rename), and a syscall-scale interleave can still briefly re-open
 *  the bridge during a live delegation; both are bounded, self-heal at the
 *  next release/heal, and degrade to the status-quo fail-closed deny. */
export function acquireBridgeSuppression(opts: SuppressionOptions = {}): () => void {
	const configPath = opts.configPath ?? mcpConfigPath();
	const markerPath = opts.markerPath ?? suppressionMarkerPath();
	const pid = opts.pid ?? process.pid;
	const isAlive = opts.isAlive ?? pidAlive;
	const now = opts.now ?? Date.now;
	const key = `${path.resolve(markerPath)}\u0000${pid}`;
	const refs = (suppressionRefs.get(key) ?? 0) + 1;
	suppressionRefs.set(key, refs);
	if (refs === 1) {
		// Marker BEFORE the config flip: a session-start heal racing between
		// the two writes reads an empty marker and would re-enable entries for
		// a delegation that is about to go live. Recording first shrinks that
		// window to the config flip itself.
		const marker = readSuppressionMarker(markerPath);
		marker.delegators[String(pid)] = { since: now() };
		bestEffortWriteMarker(markerPath, marker);
		setBridgeEntriesDisabled(true, configPath);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = Math.max(0, (suppressionRefs.get(key) ?? 1) - 1);
		if (left === 0) suppressionRefs.delete(key);
		else suppressionRefs.set(key, left);
		if (left === 0) {
			const marker = readSuppressionMarker(markerPath);
			delete marker.delegators[String(pid)];
			const { kept } = pruneDelegators(marker, isAlive, now());
			bestEffortWriteMarker(markerPath, kept);
			// Re-read right before the flip: an acquire that raced us between
			// the marker write and this read is already live and must keep its
			// suppression (a stale snapshot here would re-enable over it).
			const fresh = readSuppressionMarker(markerPath);
			if (Object.keys(fresh.delegators).length === 0) {
				setBridgeEntriesDisabled(false, configPath);
			}
		}
	};
}

export interface SuppressionOptions {
	/** Global mcp_config.json path (default: the real user config). */
	configPath?: string;
	/** Cross-process delegator marker path (default: suppression.json in the
	 *  bridge's extensions-data dir). */
	markerPath?: string;
	/** Delegator identity; defaults to this process's pid. Injectable so tests
	 *  can simulate two sessions in one process. */
	pid?: number;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
}

/** Session-start heal, marker-aware. Prunes dead or stale delegators, then
 *  re-enables the entries ONLY when no live delegator remains. A blind
 *  re-enable here used to un-hide the bridge during another session's active
 *  delegation - a plain session start in a second window could reproduce the
 *  fail-closed deny this file exists to prevent. */
export function healBridgeSuppression(opts: SuppressionOptions = {}): {
	pruned: string[];
	reEnabled: boolean;
	reason?: string;
} {
	const configPath = opts.configPath ?? mcpConfigPath();
	const markerPath = opts.markerPath ?? suppressionMarkerPath();
	const isAlive = opts.isAlive ?? pidAlive;
	const now = opts.now ?? Date.now;
	const marker = readSuppressionMarker(markerPath);
	const { kept, pruned } = pruneDelegators(marker, isAlive, now());
	if (pruned.length > 0) bestEffortWriteMarker(markerPath, kept);
	// Decide on a FRESH read, not the pruned snapshot: an acquire that raced
	// us after our write is already live and must keep its suppression.
	const fresh = readSuppressionMarker(markerPath);
	if (Object.keys(fresh.delegators).length > 0) return { pruned, reEnabled: false };
	const flip = setBridgeEntriesDisabled(false, configPath);
	return { pruned, reEnabled: flip.changed > 0, reason: flip.reason };
}

/** Default liveness probe: can the signal be delivered? */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Remove bridge entries whose owning pi process is gone (stale sweep, run
 *  at extension start). Foreign servers and live-pid entries are preserved.
 *  Entries not matching the per-pid name convention are never touched. */
export function sweepStaleBridgeServers(
	configPath: string = mcpConfigPath(),
	isAlive: (pid: number) => boolean = pidAlive,
): { removed: string[]; reason?: string } {
	const read = readConfig(configPath);
	if (!read.ok) return { removed: [], reason: read.reason };
	const removed: string[] = [];
	for (const name of Object.keys(read.config.mcpServers)) {
		const match = /^pi-bridge-(\d+)$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (Number.isFinite(pid) && !isAlive(pid)) {
			delete read.config.mcpServers[name];
			removed.push(name);
		}
	}
	if (removed.length > 0) writeConfig(configPath, read.config);
	return { removed };
}
