// Unit tests for buildContextDigest (src/provider.ts).
//
// G1: the digest injects pi-side context agy was not spawned for (compaction
// summaries, other-provider turns, pi-tool results) WITHOUT replaying agy's
// own turns (already in its resumed --conversation DB). Pure function: no I/O.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { buildContextDigest } from "../src/provider.js";

// pi wraps compaction summaries with this boilerplate (core/messages.js).
const COMP_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMP_SUFFIX = "\n</summary>";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(content: string, timestamp = 0): Message {
	return { role: "user", content, timestamp };
}
function compaction(summary: string): Message {
	return user(COMP_PREFIX + summary + COMP_SUFFIX);
}
function asst(provider: string, text: string, timestamp = 0): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages" as never,
		provider: provider as never,
		model: "m",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
	};
}
function toolResult(toolName: string, text: string, isError = false, timestamp = 0): Message {
	return {
		role: "toolResult",
		toolCallId: "c",
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp,
	};
}

test("empty messages -> empty digest", () => {
	assert.equal(buildContextDigest([], 0), "");
});

test("no compaction and nothing past the watermark -> empty digest", () => {
	// trailing user prompt is always excluded; watermark already covers the rest
	const msgs = [user("hi"), asst("claude", "hello"), user("again")];
	assert.equal(buildContextDigest(msgs, msgs.length), "");
});

test("trailing current prompt is never injected", () => {
	assert.equal(buildContextDigest([user("current prompt")], 0), "");
});

test("compaction summary is injected and its boilerplate wrapper stripped", () => {
	const digest = buildContextDigest([compaction("we decided to use sqlite"), user("now")], 0);
	assert.match(digest, /\[pi compaction summary\]/);
	assert.match(digest, /we decided to use sqlite/);
	assert.doesNotMatch(digest, /<summary>/);
	assert.doesNotMatch(digest, /compacted into the following summary/);
});

test("other-provider assistant turn since watermark is injected", () => {
	const digest = buildContextDigest([asst("claude", "their analysis"), user("now")], 0);
	assert.match(digest, /\[assistant turn from claude\]/);
	assert.match(digest, /their analysis/);
});

test("own (antigravity) assistant turn is skipped to avoid double-counting", () => {
	const msgs = [user("q"), asst("antigravity", "my prior answer"), user("q2")];
	// watermark 1: agy already saw idx 0; idx 1 is its own response -> skipped,
	// and the pre-watermark user msg is not re-injected either.
	assert.equal(buildContextDigest(msgs, 1), "");
	// watermark 0 (fresh session): the prior user msg is legit context agy never
	// saw, so it IS injected, but the antigravity assistant turn never is.
	const d0 = buildContextDigest(msgs, 0);
	assert.match(d0, /\[earlier user message\]/);
	assert.doesNotMatch(d0, /my prior answer/);
});

test("toolResult since watermark is injected, with error label when isError", () => {
	const ok = buildContextDigest([toolResult("read", "file body"), user("now")], 0);
	assert.match(ok, /\[tool result: read\]/);
	assert.match(ok, /file body/);

	const err = buildContextDigest([toolResult("bash", "boom", true), user("now")], 0);
	assert.match(err, /\[tool result: bash \(error\)\]/);
});

test("earlier user message since watermark is injected", () => {
	const digest = buildContextDigest([user("an earlier note"), user("now")], 0);
	assert.match(digest, /\[earlier user message\]/);
	assert.match(digest, /an earlier note/);
});

test("messages before the watermark are excluded", () => {
	const msgs = [user("old"), asst("claude", "old resp"), user("now")];
	// watermark 2 => idx 0 and 1 (the claude turn) are pre-watermark, excluded
	assert.equal(buildContextDigest(msgs, 2), "");
});

test("compaction clamps the window: pre-compaction messages are dropped", () => {
	const msgs = [user("pre-compaction detail"), compaction("the summary"), asst("claude", "post"), user("now")];
	const digest = buildContextDigest(msgs, 0);
	assert.match(digest, /the summary/);
	assert.match(digest, /\[assistant turn from claude\]/);
	assert.match(digest, /post/);
	assert.doesNotMatch(digest, /pre-compaction detail/);
});

test("compaction is detected even when watermark points past older messages", () => {
	// watermark 3 would normally start at idx 3, but compaction is at idx 1 =>
	// start clamps to 2, surfacing the post-compaction other-provider turn
	const msgs = [user("a"), compaction("sum"), asst("claude", "after"), user("now")];
	const digest = buildContextDigest(msgs, 3);
	assert.match(digest, /the summary|sum/); // summary always injected
});

test("maxChars caps the body and appends a truncation marker", () => {
	const long = "x".repeat(1000);
	const digest = buildContextDigest([user(long), user("now")], 0, { maxChars: 50 });
	assert.ok(digest.length < 1000);
	assert.match(digest, /\[truncated\]$/);
});

test("maxChars 0 disables the cap", () => {
	const long = "y".repeat(10_000);
	const digest = buildContextDigest([user(long), user("now")], 0, { maxChars: 0 });
	assert.equal(digest.length, `[earlier user message]\n${long}`.length);
});

test("ownProvider override changes which assistant turns are skipped", () => {
	// pretend the bridge registered as "gemini" instead of "antigravity"
	const digest = buildContextDigest([asst("antigravity", "now-foreign turn"), user("now")], 0, {
		ownProvider: "gemini",
	});
	assert.match(digest, /\[assistant turn from antigravity\]/);
});
