// Unit/integration tests for the MCP tool bridge (src/mcp-server.ts).
// Covers the capability gate, per-pid config lifecycle, shared-secret token,
// body cap, protocol-version clamp, and tool-call dispatch. Uses a stub pi and
// Node's global fetch against a real (port 0) server.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	startMcpServer,
	hasInvokeTool,
	bridgeMcpConfigDir,
	bridgeMcpConfigExists,
	registerExitCleanup,
} from "../src/mcp-server.js";

const TOKEN_HEADER = "x-bridge-token";
const configPath = () => `${bridgeMcpConfigDir()}/.agents/mcp_config.json`;
function readToken(): string {
	const c = JSON.parse(fs.readFileSync(configPath(), "utf8")) as {
		mcpServers: Record<string, { headers: Record<string, string> }>;
	};
	return c.mcpServers["pi-antigravity-bridge"].headers[TOKEN_HEADER];
}

interface Spy {
	name?: string;
	args?: unknown;
}

function makeStubPi(withInvoke: boolean, spy: Spy): ExtensionAPI {
	const pi: Record<string, unknown> = {
		getAllTools: () => [
			{
				name: "echo",
				description: "echoes args",
				parameters: { type: "object", properties: { msg: { type: "string" } } },
				sourceInfo: { source: "extension" },
			},
			{
				name: "read",
				description: "builtin",
				parameters: { type: "object" },
				sourceInfo: { source: "builtin" },
			},
		],
	};
	if (withInvoke) {
		pi.invokeTool = async (name: string, args?: unknown) => {
			spy.name = name;
			spy.args = args;
			return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }], details: {} };
		};
	}
	return pi as unknown as ExtensionAPI;
}

test("hasInvokeTool: reflects presence of pi.invokeTool", () => {
	assert.equal(hasInvokeTool({ invokeTool: () => undefined } as unknown as ExtensionAPI), true);
	assert.equal(hasInvokeTool({} as unknown as ExtensionAPI), false);
});

test("bridgeMcpConfigDir: namespaced per process pid", () => {
	assert.match(bridgeMcpConfigDir(), new RegExp(`agy-mcp-${process.pid}$`));
});

test("capability gate: no invokeTool -> ok:false, no server started", async () => {
	const r = await startMcpServer(makeStubPi(false, {}));
	assert.equal(r.ok, false);
	assert.equal(r.port, undefined);
	assert.match(r.reason ?? "", /invokeTool unavailable/);
	assert.equal(bridgeMcpConfigExists(), false);
});

test("server lifecycle: token gate, body cap, protocol clamp, tool dispatch, cleanup", async () => {
	const spy: Spy = {};
	const r = await startMcpServer(makeStubPi(true, spy), { preferredPort: 0 });
	assert.equal(r.ok, true);
	const port = r.port!;
	const url = `http://127.0.0.1:${port}/mcp`;
	const token = readToken();

	// Config written (per-pid) with a token + serverUrl.
	assert.equal(bridgeMcpConfigExists(), true);
	assert.ok(typeof token === "string" && token.length > 8);

	const post = (extraHeaders: Record<string, string>, body: unknown): Promise<Response> =>
		fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...extraHeaders,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		});

	const init = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "0" } },
	};

	// #3 shared-secret gate: missing token -> 403.
	let res = await post({}, init);
	assert.equal(res.status, 403);

	// Protocol clamp: token + MCP-Protocol-Version 2026-07-28 -> 200.
	// The SDK downgrades an unknown/newer initialize version on its own, so no
	// header rewrite is needed (the old rawHeaders mutation was dead code).
	res = await post({ [TOKEN_HEADER]: token, "MCP-Protocol-Version": "2026-07-28" }, init);
	assert.equal(res.status, 200);

	// #4 body cap: > 1 MB -> 413.
	res = await post({ [TOKEN_HEADER]: token }, { x: "a".repeat(1_100_000) });
	assert.equal(res.status, 413);

	// Tool dispatch: tools/call reaches the stub invokeTool with the right args.
	res = await post(
		{ [TOKEN_HEADER]: token, "MCP-Protocol-Version": "2025-11-25" },
		{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } },
	);
	assert.equal(res.status, 200);
	assert.equal(spy.name, "echo");
	assert.deepEqual(spy.args, { msg: "hi" });

	// Shutdown removes this process's config.
	await r.handle!.close();
	assert.equal(bridgeMcpConfigExists(), false);
});

// --- registerExitCleanup: abrupt-termination config cleanup -----------------
//
// Uses SIGUSR2 (benign, not used by the test runner or pi) as the stand-in for
// SIGINT/SIGTERM so we never risk killing the process under test. We assert
// bookkeeping (listener add/remove) and the host-ownership skip; we do NOT
// fire the signal (its handler re-raises via process.kill, which would
// terminate the runner).

test("registerExitCleanup: adds an exit listener, disposer removes it", () => {
	const before = process.listenerCount("exit");
	const dispose = registerExitCleanup(() => {}); // exit is always registered
	assert.equal(process.listenerCount("exit"), before + 1);
	dispose();
	assert.equal(process.listenerCount("exit"), before);
});

test("registerExitCleanup: installs a signal handler only when the host has none", () => {
	const sig = "SIGUSR2" as NodeJS.Signals;
	const baseline = process.listenerCount(sig); // runtime may already listen

	// Case A: host owns the signal -> we skip, no new listener.
	const disposeA = registerExitCleanup(() => {}, { signals: [sig], hasHostListener: () => true });
	assert.equal(process.listenerCount(sig), baseline);
	disposeA();
	assert.equal(process.listenerCount(sig), baseline);

	// Case B: host does NOT own it -> we install exactly one, and dispose removes it.
	const disposeB = registerExitCleanup(() => {}, { signals: [sig], hasHostListener: () => false });
	assert.equal(process.listenerCount(sig), baseline + 1);
	disposeB();
	assert.equal(process.listenerCount(sig), baseline);
});
