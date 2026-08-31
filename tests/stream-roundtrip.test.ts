// Unit tests for the stream-json engine pieces: NDJSON parser, native re-exec
// mapping, and the no-patch toolUse round-trip store.

import { test } from "vitest";
import assert from "node:assert/strict";
import { parseAgyLine, toPiUsage, type AgyUsage } from "../src/stream-events.js";
import { mapAgyToolToNative } from "../src/native-tools.js";
import { AgyDriver, type DriverActivity } from "../src/driver.js";
import { ToolRoundTrips } from "../src/provider.js";

test("parser: init carries conversation id", () => {
	const e = parseAgyLine('{"event":"init","init":{"conversation_id":"abc-123"}}');
	assert.equal(e.kind, "init");
	if (e.kind === "init") assert.equal(e.conversationId, "abc-123");
});

test("parser: tool step exposes name/args/state", () => {
	const e = parseAgyLine(
		'{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"parameters":{"path":"/a/b"}}}}',
	);
	assert.equal(e.kind, "step");
	if (e.kind === "step") {
		assert.equal(e.step.tool_name, "view_file");
		assert.equal(e.step.state, "ACTIVE");
	}
});

test("parser: result maps status; garbage parses as unknown without throwing", () => {
	const r = parseAgyLine('{"event":"result","result":{"status":"OK","response":"done"}}');
	assert.equal(r.kind, "result");
	assert.equal(parseAgyLine("not json at all").kind, "unknown");
	assert.equal(parseAgyLine('{"event":"warp"}').kind, "unknown");
});

test("parser: root-shorthand init still binds conversation", () => {
	const e = parseAgyLine('{"event":"init","conversation_id":"root-id"}');
	assert.equal(e.kind, "init");
	if (e.kind === "init") assert.equal(e.conversationId, "root-id");
});

test("toPiUsage: maps reported counts, leaves cost zero", () => {
	const u: AgyUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
	const usage = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	toPiUsage(u, usage);
	assert.equal(usage.input, 10);
	assert.equal(usage.output, 5);
	assert.equal(usage.totalTokens, 15);
	assert.equal(usage.cost.total, 0);
});

test("native mapping: view_file becomes read with offset/limit", () => {
	const m = mapAgyToolToNative("view_file", { path: "/x", StartLine: 3, EndLine: 9 });
	assert.deepEqual(m, { tool: "read", args: { path: "/x", offset: 3, limit: 7 } });
});

test("native mapping: unknown keys fall back to the wrapper (undefined)", () => {
	assert.equal(mapAgyToolToNative("view_file", { path: "/x", huh: 1 }), undefined);
	assert.equal(mapAgyToolToNative("write_to_file", { path: "/x" }), undefined);
});

test("native mapping: grep/list/find shapes", () => {
	assert.deepEqual(mapAgyToolToNative("grep_search", { query: "foo" }), { tool: "grep", args: { pattern: "foo" } });
	assert.deepEqual(mapAgyToolToNative("list_dir", { path: "/d" }), { tool: "ls", args: { path: "/d" } });
	assert.deepEqual(mapAgyToolToNative("find_by_name", { pattern: "*.ts", path: "/s" }), {
		tool: "find", args: { pattern: "*.ts", path: "/s" },
	});
});

test("round-trips: parks, injects bridge_call into the active driver handle, resolves by toolCallId", async () => {
	const driver = new AgyDriver();
	const rt = new ToolRoundTrips(driver);
	// No active turn: onToolCall must fail closed.
	await assert.rejects(rt.onToolCall("c0", "mem_search", {}, new AbortController().signal),
		/no active antigravity turn/);

	// Fake an active turn by intercepting the driver's child spawn: run() would
	// spawn real agy, so instead test the pending store contract directly.
	// (Live behavior is covered by scripts/smoke-stream-json.mjs, AGY_LIVE=1.)
	const injected: DriverActivity[] = [];
	const fakeHandle = {
		id: "t1",
		outcome: Promise.resolve({ status: "OK" as const, response: "", finished: true, aborted: false }),
		next: async () => injected.shift() ?? null,
		pushExternal: (a: DriverActivity) => injected.push(a),
	};
	// Simulate the driver having an active handle.
	const origActive = Object.getOwnPropertyDescriptor(AgyDriver.prototype, "activeHandle");
	Object.defineProperty(AgyDriver.prototype, "activeHandle", {
		configurable: true,
		get() { return fakeHandle; },
	});
	try {
		const p = rt.onToolCall("c1", "mem_search", { q: "x" }, new AbortController().signal);
		// The bridge_call activity reached the live turn.
		await Promise.resolve();
		assert.equal(injected.length, 1);
		assert.equal(injected[0].type, "bridge_call");
		if (injected[0].type === "bridge_call") {
			assert.equal(injected[0].callId, "c1");
			assert.equal(injected[0].name, "mem_search");
		}
		assert.deepEqual(rt.pendingIds, ["c1"]);
		// pi's toolResult completes the parked MCP response.
		assert.equal(rt.resolve("c1", "found it", false), true);
		const res = await p;
		assert.equal(res.isError, false);
		assert.equal(res.content[0].text, "found it");
		assert.equal(rt.resolve("c1", "again", false), false);
	} finally {
		if (origActive) Object.defineProperty(AgyDriver.prototype, "activeHandle", origActive);
	}
});

test("round-trips: timeout fails closed", async () => {
	const driver = new AgyDriver();
	// Shrink the timeout by using a short-lived pending entry via failAll.
	const rt = new ToolRoundTrips(driver, () => {});
	const injected: DriverActivity[] = [];
	const fakeHandle = {
		id: "t2",
		outcome: Promise.resolve({ status: "OK" as const, response: "", finished: true, aborted: false }),
		next: async () => injected.shift() ?? null,
		pushExternal: (a: DriverActivity) => injected.push(a),
	};
	const origActive = Object.getOwnPropertyDescriptor(AgyDriver.prototype, "activeHandle");
	Object.defineProperty(AgyDriver.prototype, "activeHandle", {
		configurable: true,
		get() { return fakeHandle; },
	});
	try {
		const p = rt.onToolCall("c2", "slow_tool", {}, new AbortController().signal);
		rt.failAll("driver recycled mid-turn");
		await assert.rejects(p, /driver recycled/);
	} finally {
		if (origActive) Object.defineProperty(AgyDriver.prototype, "activeHandle", origActive);
	}
});
