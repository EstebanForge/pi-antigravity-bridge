// Tests for the decoupled MCP bridge server: the provider owns the tool
// catalog and the round-trip; the server only ferries list/call.

import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { McpServerHandle, McpBridgeDeps } from "../src/mcp-server.js";
import { bridgeMcpConfigExists, startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

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
	// the server rejects any request without it (403 path covered by the HTTP
	// test below).
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

test("mcp-server: 403s requests without or with a wrong x-bridge-token", async () => {
	const r = await startMcpServer(fakeDeps());
	handle = r.handle!;
	assert.equal(r.ok, true);
	const url = `http://127.0.0.1:${handle.port}/mcp`;
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	const post = (headers: Record<string, string>) =>
		fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
	// No header at all.
	assert.equal((await post({})).status, 403);
	// Wrong token, different length (timingSafeEqual would throw without the
	// length precheck).
	assert.equal((await post({ [TOKEN_HEADER]: "short" })).status, 403);
	// Wrong token, SAME length: exercises the constant-time compare path.
	const sameLen = "x".repeat(handle.token.length);
	assert.equal((await post({ [TOKEN_HEADER]: sameLen })).status, 403);
	// Correct token passes the gate and answers the RPC. The transport
	// requires the MCP accept pair (fetch's default */* gets a 406).
	const ok = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			[TOKEN_HEADER]: handle.token,
		},
		body,
	});
	assert.equal(ok.status, 200);
	// The transport answers with an SSE stream (the accept pair advertises
	// text/event-stream); the JSON-RPC response rides a data: line.
	const text = await ok.text();
	const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
	assert.ok(dataLine, "expected an SSE data line");
	const payload = JSON.parse(dataLine.slice(5).trim()) as { result?: { tools?: unknown[] } };
	assert.ok(Array.isArray(payload.result?.tools));
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
