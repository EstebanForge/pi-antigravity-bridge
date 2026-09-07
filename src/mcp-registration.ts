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
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
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
