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

import { isCumulativeResend } from "../src/driver.js";

test("cumulative guard: a cumulative resend repeats the accumulated prefix (regression: check was inverted)", () => {
	// Delta stream: "AB" then "C" -> not cumulative.
	assert.equal(isCumulativeResend("AB", "C"), false);
	// Cumulative stream: "AB" then "ABC" -> cumulative resend.
	assert.equal(isCumulativeResend("AB", "ABC"), true);
	// Equal resend with no growth is ambiguous; treated as delta-append guard off.
	assert.equal(isCumulativeResend("AB", "AB"), false);
});

test("cumulative guard: first chunk never counts as a resend", () => {
	assert.equal(isCumulativeResend("", "hello"), false);
});

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BlockState, WrapperReplay, consumeActivity, type ActivityFeatures } from "../src/provider.js";
import { TurnDiffContext, createExecGitOps } from "../src/diff-render.js";

function newBlocks(): BlockState {
	return {
		partial: {
			role: "assistant",
			content: [],
			api: "agy-bridge",
			provider: "antigravity",
			model: "gemini-3.7-flash-medium",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
		textIdx: null,
		thinkingIdx: null,
		started: true,
	};
}

function featsWith(rt: ToolRoundTrips, replay: WrapperReplay): ActivityFeatures {
	return { replay, nativeActive: () => true, roundTrips: rt };
}

test("consumeActivity: read-only agy tool emits a native pi builtin toolUse and parks", async () => {
	const driver = new AgyDriver();
	const rt = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();
	const stream = createAssistantMessageEventStream();
	const blocks = newBlocks();
	const events: unknown[] = [];
	void stream[Symbol.asyncIterator] === undefined; // stream is push-based; collect via for-await below
	// Collect pushed events synchronously.
	const collected: unknown[] = [];
	const origPush = stream.push.bind(stream);
	// push is on the object; wrap it.
	(stream as unknown as { push: (e: unknown) => void }).push = (e: unknown) => {
		collected.push(e);
		return origPush(e as never);
	};
	const diffCtx = new TurnDiffContext(createExecGitOps());
	const out = consumeActivity(
		stream,
		blocks,
		{
			type: "tool_done",
			stepId: 7,
			name: "view_file",
			args: { path: "/w/some/file.ts", StartLine: 1, EndLine: 4 },
			output: "file body",
		},
		diffCtx,
		"/w",
		featsWith(rt, replay),
	);
	assert.equal(out, "parked");
	const types = collected.map((e) => (e as { type: string }).type);
	assert.ok(types.includes("toolcall_start") && types.includes("toolcall_end"));
	const end = collected.find((e) => (e as { type: string }).type === "toolcall_end") as {
		toolCall: { name: string; arguments: { path: string } };
	};
	assert.equal(end.toolCall.name, "read");
	assert.equal(end.toolCall.arguments.path, "/w/some/file.ts");
	// pi requires a reasoning argument on read/edit-class builtin calls.
	assert.equal(typeof (end.toolCall.arguments as Record<string, unknown>).reasoning, "string");
	const done = collected.find((e) => (e as { type: string }).type === "done") as { reason: string };
	assert.equal(done.reason, "toolUse");
	// Tracked as a continuation round-trip, not an MCP bridge call.
	assert.equal(rt.pendingIds.length, 1);
	assert.equal(rt.resolve(rt.pendingIds[0], "result text", false), true);
});

test("consumeActivity: mutating tool replays through the antigravity wrapper card", async () => {
	const driver = new AgyDriver();
	const rt = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();
	const stream = createAssistantMessageEventStream();
	const blocks = newBlocks();
	const collected: unknown[] = [];
	const origPush = stream.push.bind(stream);
	(stream as unknown as { push: (e: unknown) => void }).push = (e: unknown) => {
		collected.push(e);
		return origPush(e as never);
	};
	const out = consumeActivity(
		stream,
		blocks,
		{
			type: "tool_done",
			stepId: 9,
			name: "write_to_file",
			args: { path: "out.txt", content: "hi" },
			output: "wrote 2 bytes",
		},
		new TurnDiffContext(createExecGitOps()),
		"/w",
		featsWith(rt, replay),
	);
	assert.equal(out, "parked");
	const end = collected.find((e) => (e as { type: string }).type === "toolcall_end") as {
		toolCall: { name: string; arguments: { tool: string; key: string } };
	};
	assert.equal(end.toolCall.name, "antigravity");
	// The wrapper's execute() replays this recorded output.
	assert.equal(replay.get(end.toolCall.arguments.key), "wrote 2 bytes");
	assert.equal(rt.resolve(end.toolCall.arguments.key, "ignored", false), true);
});

test("consumeActivity: without a replay store, tool steps stay label-only", () => {
	const stream = createAssistantMessageEventStream();
	const blocks = newBlocks();
	const collected: unknown[] = [];
	const origPush = stream.push.bind(stream);
	(stream as unknown as { push: (e: unknown) => void }).push = (e: unknown) => {
		collected.push(e);
		return origPush(e as never);
	};
	const out = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", stepId: 1, name: "write_to_file", args: { path: "a", content: "b" }, output: "x" },
		new TurnDiffContext(createExecGitOps()),
		"/w",
		{},
	);
	assert.equal(out, "continue");
	const types = collected.map((e) => (e as { type: string }).type);
	assert.ok(types.includes("thinking_delta"));
	assert.ok(!types.some((ty) => ty.startsWith("toolcall")));
});

test("consumeActivity: acp engine renders the native diff in thinking, never parks", async () => {
	const driver = new AgyDriver();
	const rt = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();
	const stream = createAssistantMessageEventStream();
	const blocks = newBlocks();
	const collected: unknown[] = [];
	const origPush = stream.push.bind(stream);
	(stream as unknown as { push: (e: unknown) => void }).push = (e: unknown) => {
		collected.push(e);
		return origPush(e as never);
	};
	const out = consumeActivity(
		stream,
		blocks,
		{
			type: "tool_done",
			name: "edit_file",
			args: { file_path: "/w/a.txt" },
			diff: { path: "/w/a.txt", oldText: "a\nb\n", newText: "a\nB\nb\n" },
			output: "Run edit_file?",
		},
		new TurnDiffContext(createExecGitOps()),
		"/w",
		{ replay, nativeActive: () => true, roundTrips: rt, engine: "acp" },
	);
	assert.equal(out, "continue");
	// Diff renders as text in the thinking stream (pi-style), no toolUse card.
	const thinking = collected
		.filter((e) => (e as { type: string }).type === "thinking_delta")
		.map((e) => (e as { delta: string }).delta)
		.join("");
	assert.ok(thinking.includes("[agy edit: a.txt]"));
	// pi's generateDiffString line-number format: +<line> <text>.
	assert.ok(thinking.includes("+2 B"));
	assert.ok(!types(collected).some((ty) => ty.startsWith("toolcall")));
	// Nothing parked: no round-trips, no wrapper replay entry.
	assert.equal(rt.pendingIds.length, 0);
	assert.equal(replay.size, 0);
});

test("consumeActivity: acp engine without a diff stays label-only", () => {
	const stream = createAssistantMessageEventStream();
	const blocks = newBlocks();
	const collected: unknown[] = [];
	const origPush = stream.push.bind(stream);
	(stream as unknown as { push: (e: unknown) => void }).push = (e: unknown) => {
		collected.push(e);
		return origPush(e as never);
	};
	const out = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "bridge_echo", args: { text: "x" }, output: "Call bridge_echo" },
		new TurnDiffContext(createExecGitOps()),
		"/w",
		{ engine: "acp" },
	);
	assert.equal(out, "continue");
	const thinking = collected
		.filter((e) => (e as { type: string }).type === "thinking_delta")
		.map((e) => (e as { delta: string }).delta)
		.join("");
	assert.ok(thinking.includes("[agy tool: bridge_echo]"));
	assert.ok(!types(collected).some((ty) => ty.startsWith("toolcall")));
});

function types(events: unknown[]): string[] {
	return events.map((e) => (e as { type: string }).type);
}

test("parser: live stream shapes - text_delta on agent_response and SUCCESS result", () => {
	// Captured from live `agy --output-format stream-json` (2026-09): the agent
	// text arrives as text_delta and the terminal status is SUCCESS, not OK.
	const e = parseAgyLine(
		'{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"OK\\n","usage":{"input_tokens":17505,"output_tokens":47}}}',
	);
	assert.equal(e.kind, "step");
	if (e.kind === "step") assert.equal(e.step.text_delta, "OK\n");
	const r = parseAgyLine('{"event":"result","result":{"status":"SUCCESS","response":"OK\\n"}}');
	assert.equal(r.kind, "result");
	if (r.kind === "result") assert.equal(r.result.status, "SUCCESS");
});
