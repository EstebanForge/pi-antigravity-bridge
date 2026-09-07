// Early-ack + poll: slow bridge calls must not hold the tools/call HTTP
// request past agy's ~180s MCP client deadline. onToolCall settles with a
// BridgeEscalation sentinel after ~20s; the bridge answers with a poll
// handle while pi keeps executing, and the result reaches agy through
// bridge_poll_result (or the late-delivery path when agy never polls).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	EscalationRegistry,
	POLL_TOOL_NAME,
	ToolRoundTrips,
	collectToolResults,
	createStreamSimple,
	formatEscalatedAck,
	formatPollAnswer,
	type BridgeCallResultShape,
} from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

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
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-esc-")), "sessions.json");
}

const ESC = 30; // ms; fast escalation for tests

/** Fake driver: active handle for parks, null reentry (no live agy turn),
 *  recorded run() calls. Cast keeps the TurnDriver surface loose. */
class RecordingDriver {
	seen: { opts?: DriverTurnRequest } = {};
	runCalls = 0;
	#handle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	get activeHandle() {
		return this.#handle;
	}
	kickIdle(): void {}
	reentry(): null {
		return null;
	}
	async run(opts: DriverTurnRequest) {
		this.runCalls += 1;
		this.seen.opts = opts;
		return this.#handle;
	}
}

function toolResultMessage(callId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

test("escalation: fast calls settle with the real result and never register a handle", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	assert.equal(rt.resolve("c1", "file body", false), true);
	const res = (await p) as BridgeCallResultShape;
	assert.equal("escalated" in res, false);
	assert.equal(res.isError, false);
	assert.equal(res.content[0].text, "file body");
	assert.equal(rt.poll("c1"), undefined);
});

test("escalation: slow calls settle with a sentinel, poll reports running then the result", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("c1", "AskClaude", {}, new AbortController().signal);
	const res = await p;
	assert.deepEqual(res, { escalated: true, callId: "c1", name: "AskClaude" });

	const running = rt.poll("c1");
	assert.ok(running);
	assert.equal(running.state, "running");
	assert.equal(running.name, "AskClaude");

	assert.equal(rt.resolve("c1", "REVIEW OUTPUT", false), true);
	const done = rt.poll("c1");
	assert.ok(done);
	assert.equal(done.state, "done");
	assert.equal(done.text, "REVIEW OUTPUT");
	assert.equal(done.isError, false);
	// No tombstone: nothing failed, the late-delivery path must not fire.
	assert.deepEqual(rt.deadIds, []);
});

test("escalation: aborted escalated calls report through poll AND keep the tombstone backstop", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const ctrl = new AbortController();
	const settled = rt
		.onToolCall("c1", "exec_command", {}, ctrl.signal)
		.then((r) => ("escalated" in r ? "escalated" : "resolved"), () => "rejected");
	await new Promise((r) => setTimeout(r, ESC + 20));
	assert.equal(await settled, "escalated");
	// User aborts the pi tool: a REAL failure. The abort path must reach both
	// the poll handle and the late-delivery tombstone.
	ctrl.abort();
	const view = rt.poll("c1");
	assert.ok(view);
	assert.equal(view.state, "failed");
	assert.match(view.reason ?? "", /agy disconnected/);
	assert.deepEqual(rt.deadIds, ["c1"]);
});

test("escalation: failAll spares escalated calls (turn end must not fake a failure)", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("c1", "AskClaude", {}, new AbortController().signal);
	await p; // sentinel: escalated, pi tool still executing
	// extensions/index.ts fires exactly this on EVERY turn end, OK turns
	// included. An escalated call outlives the turn by design; failing it
	// here would make bridge_poll_result lie about a still-running tool.
	rt.failAll("antigravity turn ended with an unresolved pi tool call");
	const running = rt.poll("c1");
	assert.ok(running);
	assert.equal(running.state, "running");
	assert.deepEqual(rt.pendingIds, ["c1"]);
	// It still settles normally when the tool finishes.
	assert.equal(rt.resolve("c1", "REVIEW OUTPUT", false), true);
	const done = rt.poll("c1");
	assert.ok(done);
	assert.equal(done.state, "done");
});

test("escalation: continuation with a dead agy turn settles quietly for escalated calls", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: ESC });
	const p = rt.onToolCall("call-1", "AskClaude", {}, new AbortController().signal);
	await p; // sentinel: escalated

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: d as unknown as StreamDriver,
		roundTrips: rt,
	});
	const context: Context = {
		systemPrompt: undefined,
		messages: [toolResultMessage("call-1", "REVIEW OUTPUT")],
	};
	const errors: AssistantMessage[] = [];
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	// No error, no new agy prompt: the result is in the poll handle.
	assert.equal(errors.length, 0);
	assert.equal(d.runCalls, 0);
	assert.ok(rt.poll("call-1"));
	assert.equal(rt.poll("call-1")?.state, "done");
});

test("escalation: ack and poll answers are model-readable", () => {
	const ack = formatEscalatedAck({ escalated: true, callId: "abc-1", name: "AskClaude" });
	assert.equal(ack.isError, false);
	const ackText = ack.content[0].text ?? "";
	assert.match(ackText, /STILL RUNNING/);
	assert.match(ackText, /AskClaude/);
	assert.match(ackText, /abc-1/);
	assert.match(ackText, new RegExp(POLL_TOOL_NAME));

	const unknown = formatPollAnswer("nope", undefined);
	assert.equal(unknown.isError, true);
	const running = formatPollAnswer("abc-1", { state: "running", name: "AskClaude" });
	assert.match(running.content[0].text ?? "", /STILL RUNNING/);
	assert.equal(running.isError, false);
	const failed = formatPollAnswer("abc-1", { state: "failed", name: "AskClaude", reason: "boom" });
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text ?? "", /boom/);
	const done = formatPollAnswer("abc-1", { state: "done", name: "AskClaude", text: "the answer", isError: false });
	assert.equal(done.isError, false);
	assert.equal(done.content[0].text, "the answer");
});

test("escalation: registry soft cap never evicts running entries", () => {
	const reg = new EscalationRegistry();
	for (let i = 0; i < 70; i++) reg.escalate(`c${i}`, "tool");
	// Saturating the cap with in-flight calls grows the map instead of
	// stranding a running result (settle on an evicted id is a no-op).
	assert.ok(reg.poll("c0"));
	assert.equal(reg.poll("c0")?.state, "running");
	// Only settled entries evict, oldest first.
	reg.settleDone("c0", "out", false);
	reg.escalate("c70", "tool");
	assert.equal(reg.poll("c0"), undefined);
	assert.equal(reg.poll("c1")?.state, "running");
	assert.equal(reg.poll("c70")?.state, "running");
	assert.equal(reg.poll("missing"), undefined);
});

// --- image blocks over the bridge (ACP engine) ---------------------------------

const IMG = { data: "aWNvbg==", mimeType: "image/png" };

function toolResultImageMessage(callId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [
			{ type: "text", text },
			{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
			// Malformed entries must be dropped, not forwarded.
			{ type: "image", mimeType: "image/jpeg" },
			{ type: "image", data: "", mimeType: "image/png" },
			{ type: "thinking", thinking: "x" },
		],
		isError: false,
		timestamp: Date.now(),
	} as unknown as Message;
}

test("bridge images: collectToolResults extracts image blocks from parked tool results", () => {
	const msgs = [toolResultImageMessage("c1", "Read image file [image/png]")];
	const out = collectToolResults(msgs, ["c1"]);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "Read image file [image/png]");
	assert.deepEqual(out[0].images, [IMG]);
	// No images on plain results; unknown ids never surface.
	assert.deepEqual(collectToolResults([toolResultMessage("c2", "txt")], ["c2"])[0].images, []);
});

test("bridge images: fast (non-escalated) resolve emits image content ahead of text", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	rt.resolve("c1", "Read image file [image/png]", false, [IMG]);
	const res = (await p) as BridgeCallResultShape;
	assert.equal(res.isError, false);
	assert.deepEqual(res.content[0], { type: "image", data: IMG.data, mimeType: IMG.mimeType });
	assert.equal(res.content[1].text, "Read image file [image/png]");
});

test("bridge images: escalated resolve carries images through poll and formatPollAnswer", () => {
	const reg = new EscalationRegistry();
	reg.escalate("c1", "read");
	reg.settleDone("c1", "Read image file [image/png]", false, [IMG]);
	const view = reg.poll("c1");
	assert.ok(view);
	assert.deepEqual(view.images, [IMG]);
	const res = formatPollAnswer("c1", view);
	assert.equal(res.isError, false);
	assert.deepEqual(res.content[0], { type: "image", data: IMG.data, mimeType: IMG.mimeType });
	assert.equal(res.content[1].text, "Read image file [image/png]");
});

// The engine gate lives at the runTurnDriver resolve call site, not in
// ToolRoundTrips: drive a real continuation through createStreamSimple to
// pin it. Deleting or inverting the ternary must turn these red.
async function driveContinuation(engine: "stream-json" | "acp"): Promise<BridgeCallResultShape> {
	// Two DISTINCT stubs: createStreamSimple labels the engine by object
	// identity (selected === deps.acpDriver), so a shared instance would
	// mislabel the stream-json run as acp.
	const dStream = new RecordingDriver();
	const dAcp = new RecordingDriver();
	const rt = new ToolRoundTrips(dStream as unknown as StreamDriver, undefined, { escalateAfterMs: 5_000 });
	const p = rt.onToolCall("c1", "read", {}, new AbortController().signal);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver: dStream as unknown as StreamDriver,
		acpDriver: dAcp as unknown as StreamDriver,
		roundTrips: rt,
		engine,
	});
	const context: Context = {
		systemPrompt: undefined,
		messages: [toolResultImageMessage("c1", "Read image file [image/png]")],
	};
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	for await (const _ev of stream) {
		// Drain: the parked promise settles inside the continuation pass; the
		// post-resolve branch may finalize an error (no live turn to re-enter).
	}
	return (await p) as BridgeCallResultShape;
}

test("bridge images: engine gate drops pixels on stream-json", async () => {
	const res = await driveContinuation("stream-json");
	assert.deepEqual(res.content, [{ type: "text", text: "Read image file [image/png]" }]);
});

test("bridge images: engine gate forwards pixels on acp", async () => {
	const res = await driveContinuation("acp");
	assert.deepEqual(res.content, [
		{ type: "image", data: IMG.data, mimeType: IMG.mimeType },
		{ type: "text", text: "Read image file [image/png]" },
	]);
});
