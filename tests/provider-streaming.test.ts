// Provider effort-mapping tests. Drives createStreamSimple with an injected
// fake driver (no agy spawn, no network) and asserts how the provider
// translates pi's options.reasoning into the agy --effort tier: forwarded
// for effort-driven bases, clamped to the base's supported tiers, omitted
// for fixed-thinking models. toAgyEffort itself is pinned by a pure unit test.
//
// The legacy provider event-mapping tests (close-on-switch, tool labels,
// empty turn) died with the legacy-sqlite engine; the stream-json path is
// covered by tests/stream-roundtrip.test.ts.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Api, Context, Model, SimpleStreamOptions, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ToolRoundTrips, WrapperReplay, consumeActivity, createStreamSimple, toAgyEffort } from "../src/provider.js";
import { TurnDiffContext } from "../src/diff-render.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyDriver, DriverTurnRequest } from "../src/driver.js";

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

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-prov-")), "sessions.json");
}

/** A fake driver that records the run() opts so a test can assert how the
 *  provider translated pi's options into agy turn opts. The handle emits no
 *  activities and settles OK. */
function capturingDriver(seen: { opts?: DriverTurnRequest }): AgyDriver {
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as AgyDriver;
}

/** Run one scripted turn through streamSimple; returns the captured turn
 *  request the provider handed to the driver. */
async function captureTurn(
	entry: { full: string; id: string; efforts?: ("low" | "medium" | "high")[] },
	reasoning: string | undefined,
): Promise<DriverTurnRequest | undefined> {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [entry],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const stream = streamSimple(
		{ ...model, id: entry.id },
		contextWith("ignored by fake"),
		{ cwd: process.cwd(), reasoning } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	return seen.opts;
}

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

test("streamSimple forwards image blocks from the user message to the driver", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context: Context = {
		systemPrompt: undefined,
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: [
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "text", text: "What is this?" },
				],
			},
		],
	};
	const stream = streamSimple(
		{ ...model, id: "gemini-flash" },
		context,
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	// Text rides as the prompt; images ride separately (the legacy driver
	// ignores them, the ACP driver forwards them as typed content blocks).
	assert.equal(seen.opts?.prompt, "What is this?");
	assert.deepEqual(seen.opts?.images, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("streamSimple forwards options.reasoning as effort for an effort-driven base", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] },
		"high",
	);
	assert.equal(opts?.model, "gemini-3.6-flash");
	assert.equal(opts?.effort, "high");
});

test("streamSimple clamps an unsupported tier to the base's nearest effort", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.1-pro", id: "pro", efforts: ["low", "high"] },
		// medium is not valid for Pro (hidden in the toggle); provider clamps to high.
		"medium",
	);
	assert.equal(opts?.model, "gemini-3.1-pro");
	assert.equal(opts?.effort, "high");
});

test("streamSimple omits effort for a fixed (non-effort) model", async () => {
	const opts = await captureTurn({ full: "claude-sonnet-4-6", id: "claude-sonnet" }, "high");
	assert.equal(opts?.model, "claude-sonnet-4-6");
	assert.equal(opts?.effort, undefined);
});

test("Gate C: consumeActivity parks for native-tools on stream-json engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "stream-json" },
	);
	assert.equal(res, "parked");
	assert.equal(partial.stopReason, "toolUse");
});

test("Gate C: consumeActivity skips native re-exec and wrapper replay on ACP engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "acp" },
	);
	assert.equal(res, "continue");
	assert.equal(partial.stopReason, "stop");
	assert.ok(partial.content.some((b) => b.type === "thinking" && b.thinking.includes("[agy tool: view_file]")));
});
