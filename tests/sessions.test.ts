// Unit tests for SessionStore load-time narrowing (src/sessions.ts).
//
// Proves a corrupt or hand-edited sessions.json can't plant wrong-typed fields
// into the cache: malformed entries are dropped and bad lastStepIdx values fall
// back to -1. Written as raw JSON text (not JSON.stringify) so the 1e999 token
// survives as Infinity through JSON.parse.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/sessions.js";

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-sessions-")), "sessions.json");
}

test("SessionStore: missing file starts empty (no throw)", () => {
	const store = new SessionStore(tmpStorePath());
	assert.equal(store.size, 0);
	assert.equal(store.get("anything"), null);
});

test("SessionStore: load drops malformed entries, keeps valid ones", () => {
	const p = tmpStorePath();
	fs.writeFileSync(
		p,
		JSON.stringify({
			good: { conversationId: "abc-123", lastStepIdx: 5 },
			badId: { conversationId: 123, lastStepIdx: 2 }, // id not a string -> drop
			badIdx: { conversationId: "xyz", lastStepIdx: "no" }, // idx not a number -> keep, -1
			nonObj: "string-value", // not an object -> drop
			missing: { lastStepIdx: 3 }, // no conversationId -> drop
		}) + "\n",
	);
	const store = new SessionStore(p);
	assert.deepEqual(store.get("good"), { conversationId: "abc-123", lastStepIdx: 5, lastMessageCount: 0 });
	assert.equal(store.get("badId"), null);
	assert.deepEqual(store.get("badIdx"), { conversationId: "xyz", lastStepIdx: -1, lastMessageCount: 0 });
	assert.equal(store.get("nonObj"), null);
	assert.equal(store.get("missing"), null);
});

test("SessionStore: non-finite lastStepIdx (Infinity from 1e999) falls back to -1", () => {
	const p = tmpStorePath();
	// Raw text: 1e999 parses to Infinity, which Number.isFinite rejects.
	fs.writeFileSync(p, `{"huge": {"conversationId": "big", "lastStepIdx": 1e999}}\n`);
	const store = new SessionStore(p);
	assert.deepEqual(store.get("huge"), { conversationId: "big", lastStepIdx: -1, lastMessageCount: 0 });
});

test("SessionStore: set/get round-trip in memory (incl. lastMessageCount watermark)", () => {
	const store = new SessionStore(tmpStorePath());
	store.set("k", { conversationId: "c-1", lastStepIdx: 9, lastMessageCount: 42 });
	assert.deepEqual(store.get("k"), { conversationId: "c-1", lastStepIdx: 9, lastMessageCount: 42 });
	assert.equal(store.size, 1);
});

test("SessionStore: top-level non-object file is treated as empty", () => {
	const p = tmpStorePath();
	fs.writeFileSync(p, `[1, 2, 3]`); // array, not an object
	const store = new SessionStore(p);
	assert.equal(store.size, 0);
});
