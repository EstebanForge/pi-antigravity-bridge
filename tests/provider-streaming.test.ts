// Provider event-mapping tests. Drives createStreamSimple with an injected
// fake runner (no agy spawn, no network) and asserts the exact stream event
// sequence the provider emits: text/thinking close-on-switch, tool labels
// routed through the thinking block, and the empty-turn fallback.
//
// These guard the just-refactored streaming path (provider.ts), which had no
// direct coverage: a wrong event order, a missed close-on-switch, or a tool
// label that stops surfacing would all pass the runner tests but fail here.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createStreamSimple, toAgyEffort } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import { runAgyTurn, type AgyEvent, type AgyRunOptions, type AgyRunResult } from "../src/runner.js";

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

function contextWith(prompt: string): Context {
	return {
		systemPrompt: undefined,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
}

/** Build a fake runner that replays `events` in order, then resolves a clean
 *  successful result. `result` lets a test force exitCode/conversationId. */
function fakeRunner(
	events: AgyEvent[],
	result: Partial<AgyRunResult> = {},
): typeof runAgyTurn {
	return async (_opts, onEvent) => {
		for (const e of events) onEvent(e);
		return {
			exitCode: 0,
			conversationId: "11111111-1111-4111-8111-111111111111",
			lastIdx: events.length,
			aborted: false,
			timedOut: false,
			stderr: "",
			durationMs: 1,
			...result,
		};
	};
}

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-prov-")), "sessions.json");
}

/** Run one scripted turn and collect the full stream event list. */
async function runTurn(events: AgyEvent[], result?: Partial<AgyRunResult>): Promise<AssistantMessageEvent[]> {
	const streamSimple = createStreamSimple({
		entries: [],
		store: new SessionStore(tmpStorePath()),
		runAgyTurn: fakeRunner(events, result),
	});
	const stream = streamSimple(
		model,
		contextWith("ignored by fake"),
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	const out: AssistantMessageEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

const types = (events: AssistantMessageEvent[]): string[] => events.map((e) => e.type);
const joinText = (events: AssistantMessageEvent[]): string =>
	events
		.filter((e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta")
		.map((e) => e.delta)
		.join("");
const joinThinking = (events: AssistantMessageEvent[]): string =>
	events
		.filter((e): e is Extract<AssistantMessageEvent, { type: "thinking_delta" }> => e.type === "thinking_delta")
		.map((e) => e.delta)
		.join("");

test("close-on-switch: text -> thinking -> text emits the full open/close sequence", async () => {
	const events = await runTurn([
		{ kind: "text", text: "a" },
		{ kind: "thinking", text: "b" },
		{ kind: "text", text: "c" },
	]);

	// Each switch closes the prior block (text_end / thinking_end) before opening
	// the next; contentIndex advances per new block (0 text, 1 thinking, 2 text).
	assert.deepEqual(types(events), [
		"start",
		"text_start", "text_delta", "text_end",
		"thinking_start", "thinking_delta", "thinking_end",
		"text_start", "text_delta", "text_end",
		"done",
	]);
	assert.equal(joinText(events), "ac");
	assert.equal(joinThinking(events), "b");

	// The terminal done carries the final assembled message.
	const done = events.find(
		(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
	);
	assert.ok(done, "stream must terminate with done");
	assert.equal(done!.message.stopReason, "stop");
});

test("tool events route through the thinking block as a label", async () => {
	const events = await runTurn([
		{ kind: "text", text: "answer" },
		{ kind: "tool", name: "read_file", inputJson: "" },
	]);

	// Text closes when the tool label opens a thinking block; the label survives.
	assert.deepEqual(types(events), [
		"start",
		"text_start", "text_delta", "text_end",
		"thinking_start", "thinking_delta", "thinking_end",
		"done",
	]);
	assert.equal(joinText(events), "answer");
	assert.ok(
		joinThinking(events).includes("[agy tool: read_file]"),
		`thinking block should carry the tool label, got: ${JSON.stringify(joinThinking(events))}`,
	);
});

test("empty turn: no agy events still yields a well-formed text block + done", async () => {
	const events = await runTurn([]);

	// Fallback opens an empty text block so pi has a valid assistant turn.
	assert.deepEqual(types(events), ["start", "text_start", "text_end", "done"]);
	const done = events.find(
		(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
	);
	assert.ok(done);
	const textBlocks = done!.message.content.filter((b) => b.type === "text");
	assert.equal(textBlocks.length, 1);
	assert.equal((textBlocks[0] as { text: string }).text, "");
});

test("agy exit failure surfaces as an error event, not a hang", async () => {
	const events = await runTurn([], {
		exitCode: 1,
		stderr: "agy blew up",
		conversationId: null,
	});

	assert.equal(types(events).at(-1), "error");
	const err = events.find(
		(e): e is Extract<AssistantMessageEvent, { type: "error" }> => e.type === "error",
	);
	assert.ok(err);
	assert.equal(err!.error.stopReason, "error");
	assert.ok(
		(err!.error.errorMessage ?? "").includes("agy blew up"),
		`error message should carry agy stderr, got: ${JSON.stringify(err!.error.errorMessage)}`,
	);
});

// --- reasoning-effort bridging (agy --effort) ---------------------------------

test("toAgyEffort maps pi levels onto the base's supported tiers (clamped)", () => {
	const flash = ["low", "medium", "high"] as const;
	const pro = ["low", "high"] as const;
	assert.equal(toAgyEffort("low", flash), "low");
	assert.equal(toAgyEffort("medium", flash), "medium");
	assert.equal(toAgyEffort("high", flash), "high");
	assert.equal(toAgyEffort("minimal", flash), "low");
	// Pro has no medium -> clamp up to nearest available (high).
	assert.equal(toAgyEffort("medium", pro), "high");
	assert.equal(toAgyEffort("low", pro), "low");
	assert.equal(toAgyEffort("high", pro), "high");
	// No level -> default to the cheapest available tier.
	assert.equal(toAgyEffort(undefined, flash), "low");
	assert.equal(toAgyEffort(undefined, pro), "low");
});

/** A runner that records the opts it was called with, so a test can assert how
 *  the provider translated pi's options into agy run opts. */
function capturingRunner(seen: { opts?: AgyRunOptions }): typeof runAgyTurn {
	return async (opts) => {
		seen.opts = opts;
		return {
			exitCode: 0,
			conversationId: "11111111-1111-4111-8111-111111111111",
			lastIdx: 0,
			aborted: false,
			timedOut: false,
			stderr: "",
			durationMs: 1,
		};
	};
}

test("streamSimple forwards options.reasoning as effort for an effort-driven base", async () => {
	const seen: { opts?: AgyRunOptions } = {};
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store: new SessionStore(tmpStorePath()),
		runAgyTurn: capturingRunner(seen),
	});
	const stream = streamSimple(
		{ ...model, id: "gemini-flash", reasoning: true },
		contextWith("hi"),
		{ cwd: process.cwd(), reasoning: "high" } as unknown as SimpleStreamOptions,
	);
	for await (const _ev of stream) void _ev;

	assert.equal(seen.opts?.model, "gemini-3.6-flash");
	assert.equal(seen.opts?.effort, "high");
});

test("streamSimple clamps an unsupported tier to the base's nearest effort", async () => {
	const seen: { opts?: AgyRunOptions } = {};
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.1-pro", id: "pro", efforts: ["low", "high"] }],
		store: new SessionStore(tmpStorePath()),
		runAgyTurn: capturingRunner(seen),
	});
	const stream = streamSimple(
		{ ...model, id: "pro", reasoning: true },
		contextWith("hi"),
		// medium is not valid for Pro (hidden in the toggle); provider clamps to high.
		{ cwd: process.cwd(), reasoning: "medium" } as unknown as SimpleStreamOptions,
	);
	for await (const _ev of stream) void _ev;

	assert.equal(seen.opts?.model, "gemini-3.1-pro");
	assert.equal(seen.opts?.effort, "high");
});

test("streamSimple omits effort for a fixed (non-effort) model", async () => {
	const seen: { opts?: AgyRunOptions } = {};
	const streamSimple = createStreamSimple({
		entries: [{ full: "claude-sonnet-4-6", id: "claude-sonnet" }],
		store: new SessionStore(tmpStorePath()),
		runAgyTurn: capturingRunner(seen),
	});
	const stream = streamSimple(
		{ ...model, id: "claude-sonnet" },
		contextWith("hi"),
		{ cwd: process.cwd(), reasoning: "high" } as unknown as SimpleStreamOptions,
	);
	for await (const _ev of stream) void _ev;

	assert.equal(seen.opts?.model, "claude-sonnet-4-6");
	assert.equal(seen.opts?.effort, undefined);
});
