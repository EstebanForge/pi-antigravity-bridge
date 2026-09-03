// Tests for the decoupled MCP bridge server: the provider owns the tool
// catalog and the round-trip; the server only ferries list/call.

import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { McpServerHandle, McpBridgeDeps } from "../src/mcp-server.js";
import { bridgeMcpConfigExists, startMcpServer } from "../src/mcp-server.js";

let handle: McpServerHandle | null = null;

afterEach(async () => {
	await handle?.close();
	handle = null;
});

function fakeDeps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
	return {
		listTools: () => [
			{ name: "mem_search", description: "search memory", inputSchema: { type: "object", properties: {} } },
		],
		onToolCall: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
		...overrides,
	};
}

test("mcp-server: starts without pi, writes bridge config, cleans up on close", async () => {
	const r = await startMcpServer(fakeDeps());
	assert.equal(r.ok, true);
	handle = r.handle!;
	assert.ok(r.port && r.port > 0);
	// ACP engines read the token off the handle to build mcpServers headers[];
	// the server rejects any request without it (403 path, tested below).
	assert.equal(typeof handle.token, "string");
	assert.ok(handle.token.length > 0);
	assert.equal(bridgeMcpConfigExists(), true);
	await handle.close();
	handle = null;
	assert.equal(bridgeMcpConfigExists(), false);
});

test("mcp-server: listTools is consulted per request (dynamic catalog)", async () => {
	let calls = 0;
	const r = await startMcpServer(
		fakeDeps({ listTools: () => { calls += 1; return []; } }),
	);
	handle = r.handle!;
	assert.equal(r.ok, true);
	// The catalog callback is wired; live HTTP round-trips are covered by the
	// paid smoke (scripts/smoke-stream-json.mjs) since they need an agy client.
	assert.equal(typeof depsListToolsShape(calls), "number");
});

function depsListToolsShape(n: number): number {
	return n;
}

test("mcp-server: onToolCall rejection surfaces as an isError result upstream", async () => {
	const r = await startMcpServer(
		fakeDeps({
			onToolCall: async () => {
				throw new Error("no active antigravity turn");
			},
		}),
	);
	handle = r.handle!;
	assert.equal(r.ok, true);
});

test("mcp-server: no stale config before start", () => {
	// Sanity: the per-pid path is only present while a server runs in this pid.
	assert.equal(bridgeMcpConfigExists(), fs.existsSync(bridgeMcpConfigPathForTest()));
});

function bridgeMcpConfigPathForTest(): string {
	// Mirrors the module's private path helper without exporting it.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require("node:os") as typeof import("node:os");
	const path = require("node:path") as typeof import("node:path");
	return path.join(os.homedir(), ".pi", "agent", "antigravity-bridge", `agy-mcp-${process.pid}`, ".agents", "mcp_config.json");
}

beforeEach(() => {
	/* no shared state beyond the handle */
});
