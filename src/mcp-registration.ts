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
 *  in the file are preserved. */
export function registerBridgeServer(
	entry: { pid: number; port: number; token: string; tokenHeader: string },
	configPath: string = mcpConfigPath(),
): { wrote: boolean; reason?: string } {
	const read = readConfig(configPath);
	if (!read.ok) return { wrote: false, reason: read.reason };
	read.config.mcpServers[bridgeServerName(entry.pid)] = {
		disabled: false,
		headers: { [entry.tokenHeader]: entry.token },
		serverUrl: `http://127.0.0.1:${entry.port}/mcp`,
	} satisfies BridgeServerEntry;
	writeConfig(configPath, read.config);
	return { wrote: true };
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

const suppressionRefs = new Map<string, number>();

/** Reference-counted suppression for a self-spawned agy process (AskAntigravity
 *  delegation). First acquire disables every pi-bridge-* entry, last release
 *  re-enables; nested acquires are free, so overlapping delegations in one
 *  process cannot clobber each other's window. Same-process only: delegations
 *  from two pi sessions still race on the shared file - accepted, fail-open
 *  to the status-quo error. */
export function acquireBridgeSuppression(configPath: string = mcpConfigPath()): () => void {
	const key = path.resolve(configPath);
	const refs = (suppressionRefs.get(key) ?? 0) + 1;
	suppressionRefs.set(key, refs);
	if (refs === 1) setBridgeEntriesDisabled(true, configPath);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = Math.max(0, (suppressionRefs.get(key) ?? 1) - 1);
		if (left === 0) suppressionRefs.delete(key);
		else suppressionRefs.set(key, left);
		if (left === 0) setBridgeEntriesDisabled(false, configPath);
	};
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
