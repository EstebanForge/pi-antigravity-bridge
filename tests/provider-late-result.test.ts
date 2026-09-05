// Late tool-result delivery: when a bridge park dies while the pi tool is
// still running (agy's ~180s MCP client timeout on tools/call aborts the
// HTTP request, mcp-server aborts the park), the toolResult arrives with the
// park gone. The provider must re-route the result to agy as a new prompt in
// the same conversation instead of erroring "No user message to send to agy."
//
// Regression source: 2026-09-05 incident. An AskClaude opus peer review ran
// 225.7s, the park died at exactly 180.000s, agy salvaged its turn while the
// result was dropped and the turn errored.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.6 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-late-")), "sessions.json");
}

/** Fake driver with an always-active handle (bridge parks need one) and a
 *  run() that records the request. No agy spawn, no network. */
function fakeDriver(seen: { opts?: DriverTurnRequest }) {
	const fakeHandle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	return {
		get activeHandle() {
			return fakeHandle;
		},
		kickIdle: () => {},
		reentry: () => null,
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return fakeHandle;
		},
	} as unknown as AgyDriver;
}

/** Park a bridge call, then fail it the way the abort/timeout/recycle paths
 *  do. Returns the settled onToolCall rejection message. */
async function parkAndFail(rt: ToolRoundTrips, callId: string, name: string, reason: string): Promise<string> {
	const settled = rt
		.onToolCall(callId, name, {}, new AbortController().signal)
		.then(
			() => "resolved",
			(err: unknown) => (err instanceof Error ? err.message : "rejected"),
		);
	rt.failAll(reason);
	return settled;
}

function toolResultMessage(callId: string, text: string, isError = false): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as unknown as Message;
}

/** Run one scripted turn through streamSimple; returns the driver request the
 *  provider handed over plus any error events. */
function makeStreamSimple(driver: AgyDriver, rt: ToolRoundTrips) {
	return createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: rt,
	});
}

async function collect(stream: ReturnType<ReturnType<typeof createStreamSimple>>): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

test("tombstones: a failed park is recorded, consumed once, then gone", async () => {
	const driver = fakeDriver({});
	const rt = new ToolRoundTrips(driver);
	const msg = await parkAndFail(rt, "c1", "AskClaude", "test expiry");
	assert.match(msg, /test expiry/);
	assert.deepEqual(rt.pendingIds, []);
	assert.deepEqual(rt.deadIds, ["c1"]);
	assert.deepEqual(rt.consumeDead("c1"), { name: "AskClaude", reason: "test expiry" });
	assert.equal(rt.consumeDead("c1"), undefined);
	assert.deepEqual(rt.deadIds, []);
});

test("tombstones: a resolved park leaves no tombstone", async () => {
	const driver = fakeDriver({});
	const rt = new ToolRoundTrips(driver);
	const settled = rt.onToolCall("c1", "exec_command", {}, new AbortController().signal);
	rt.resolve("c1", "done", false);
	await settled;
	assert.deepEqual(rt.deadIds, []);
});

test("tombstones: bounded (oldest evicted past the cap)", async () => {
	const driver = fakeDriver({});
	const rt = new ToolRoundTrips(driver);
	for (let i = 0; i < 70; i++) await parkAndFail(rt, `c${i}`, "tool", "expired");
	assert.equal(rt.deadIds.length, 64);
	// Oldest (c0..c5) evicted, newest kept.
	assert.equal(rt.deadIds.includes("c0"), false);
	assert.equal(rt.deadIds.includes("c69"), true);
});

test("late delivery: incident repro, tool result after park death runs as a new agy prompt", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	await parkAndFail(rt, "call-1", "AskClaude", "agy disconnected before the tool result arrived");

	const context: Context = {
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "peer review wp-plugin", timestamp: Date.now() },
			toolResultMessage("call-1", "REVIEW OUTPUT", false),
		],
	};
	const errors = await collect(makeStreamSimple(driver, rt)(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));

	// The turn ran (no error) and the prompt frames the late result.
	assert.equal(errors.length, 0);
	assert.ok(seen.opts, "driver.run was called");
	assert.match(seen.opts.prompt, /Late tool delivery/);
	assert.match(seen.opts.prompt, /AskClaude/);
	assert.match(seen.opts.prompt, /agy disconnected before the tool result arrived/);
	assert.match(seen.opts.prompt, /REVIEW OUTPUT/);
	// The old user message is NOT re-sent (extractUserPrompt reads the last
	// message only, and the last message is the toolResult).
	assert.equal(seen.opts.prompt.includes("peer review wp-plugin"), false);
	// Tombstone consumed: no double delivery.
	assert.deepEqual(rt.deadIds, []);
});

test("late delivery: tombstone is single-shot, the same context then errors as an empty fresh turn", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	await parkAndFail(rt, "call-1", "AskClaude", "expired");
	const context: Context = {
		systemPrompt: undefined,
		messages: [toolResultMessage("call-1", "REVIEW OUTPUT")],
	};
	const streamSimple = makeStreamSimple(driver, rt);
	const options = { cwd: process.cwd() } as unknown as SimpleStreamOptions;

	// First pass: delivered.
	const errors1 = await collect(streamSimple(model, context, options));
	assert.equal(errors1.length, 0);
	assert.ok(seen.opts);

	// Second pass: tombstone consumed, nothing left to send.
	seen.opts = undefined;
	const errors2 = await collect(streamSimple(model, context, options));
	assert.equal(seen.opts, undefined);
	assert.equal(errors2.length, 1);
	assert.equal(errors2[0].errorMessage, "No user message to send to agy.");
});

test("late delivery: a queued user message rides along with the late result", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	await parkAndFail(rt, "call-1", "AskClaude", "expired");
	const context: Context = {
		systemPrompt: undefined,
		messages: [
			toolResultMessage("call-1", "REVIEW OUTPUT"),
			{ role: "user", content: "now run the tests", timestamp: Date.now() },
		],
	};
	const errors = await collect(makeStreamSimple(driver, rt)(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.match(seen.opts.prompt, /REVIEW OUTPUT/);
	assert.match(seen.opts.prompt, /now run the tests$/);
});

test("late delivery: deferred while a pending park anchors the pass, delivered on the next fresh pass", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 30 });
	// A: escalated (poll handle out, pi still executing).
	const a = rt.onToolCall("call-a", "AskClaude", {}, new AbortController().signal);
	await a;
	// B: park fails while A runs (abort path) -> tombstone.
	const bCtrl = new AbortController();
	const b = rt.onToolCall("call-b", "exec_command", {}, bCtrl.signal).catch(() => "rejected");
	bCtrl.abort();
	await b;
	assert.deepEqual(rt.deadIds, ["call-b"]);

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: rt,
	});
	const options = { cwd: process.cwd() } as unknown as SimpleStreamOptions;

	// Pass 1: continuation anchored by A's result; B must be deferred, not
	// consumed (there is nowhere to put it this pass).
	const context1: Context = {
		systemPrompt: undefined,
		messages: [toolResultMessage("call-a", "A OUTPUT"), toolResultMessage("call-b", "B OUTPUT")],
	};
	const errors1: AssistantMessage[] = [];
	const s1 = streamSimple(model, context1, options);
	for await (const ev of s1) {
		if (ev.type === "error") errors1.push(ev.error);
	}
	assert.equal(errors1.length, 0); // quiet stop via the escalated path
	assert.deepEqual(rt.deadIds, ["call-b"]); // tombstone survived for pass 2
	assert.equal(rt.poll("call-a")?.state, "done");
	assert.equal(seen.opts, undefined); // no new agy prompt this pass

	// Pass 2: fresh pass (no pending parks) delivers B as a late prompt. A
	// fresh driver instance keeps the per-pass capture clean.
	const seen2: { opts?: DriverTurnRequest } = {};
	const driver2 = fakeDriver(seen2);
	const streamSimple2 = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: driver2,
		roundTrips: rt,
	});
	const context2: Context = {
		systemPrompt: undefined,
		messages: [
			toolResultMessage("call-b", "B OUTPUT"),
			{ role: "user", content: "continue", timestamp: Date.now() },
		],
	};
	const s2 = streamSimple2(model, context2, options);
	for await (const ev of s2) void ev;
	assert.ok(seen2.opts);
	assert.match(seen2.opts.prompt, /B OUTPUT/);
	assert.match(seen2.opts.prompt, /exec_command/);
	assert.match(seen2.opts.prompt, /continue$/);
	assert.deepEqual(rt.deadIds, []);
});

test("late delivery: error results are flagged in the prompt", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = fakeDriver(seen);
	const rt = new ToolRoundTrips(driver);
	await parkAndFail(rt, "call-1", "exec_command", "expired");
	const context: Context = {
		systemPrompt: undefined,
		messages: [toolResultMessage("call-1", "exit code 1", true)],
	};
	const errors = await collect(makeStreamSimple(driver, rt)(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions));
	assert.equal(errors.length, 0);
	assert.ok(seen.opts);
	assert.match(seen.opts.prompt, /reported an error/);
	assert.match(seen.opts.prompt, /exit code 1/);
});
