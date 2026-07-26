// Unit tests for conversation-id discovery.
//
// Covers the diff-based happy path AND the concurrent-run disambiguation that
// resolves ambiguity via an injectable process-tree FD resolver (the real
// implementation scans /proc/<pid>/fd on Linux; here we inject a stub so the
// suite is deterministic and platform-independent).
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	newConversationId,
	procTreeOpenDbResolver,
	snapshotConversations,
	type OpenDbResolver,
} from "../src/discovery.js";

/** Fresh temp conversations dir seeded with `ids`. Returns its path. */
function seed(ids: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-disc-"));
	for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.db`), "");
	return dir;
}

test("snapshotConversations: lists *.db stems, ignores other files", () => {
	const dir = seed(["aaa", "bbb"]);
	fs.writeFileSync(path.join(dir, "ccc.pb"), "");
	fs.writeFileSync(path.join(dir, "ignore-me"), "");
	const snap = snapshotConversations(dir);
	assert.deepEqual([...snap].sort(), ["aaa", "bbb"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("snapshotConversations: empty set when dir missing (agy creates it)", () => {
	const snap = snapshotConversations(path.join(os.tmpdir(), "agy-does-not-exist-xyz"));
	assert.equal(snap.size, 0);
});

test("newConversationId: 0 new -> null", () => {
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	assert.equal(newConversationId(dir, before), null);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newConversationId: exactly 1 new -> that id", () => {
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	fs.writeFileSync(path.join(dir, "ours.db"), "");
	assert.equal(newConversationId(dir, before), "ours");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newConversationId: >1 new and no pid -> null (fail safe, legacy behavior)", () => {
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	fs.writeFileSync(path.join(dir, "ours.db"), "");
	fs.writeFileSync(path.join(dir, "theirs.db"), "");
	assert.equal(newConversationId(dir, before), null);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newConversationId: >1 new, resolver picks a candidate -> that id", () => {
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	fs.writeFileSync(path.join(dir, "ours.db"), "");
	fs.writeFileSync(path.join(dir, "theirs.db"), "");
	const stub: OpenDbResolver = (_pid, _dir, candidates) =>
		candidates.has("ours") ? "ours" : null;
	assert.equal(newConversationId(dir, before, { pid: 1, resolveOpenDb: stub }), "ours");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newConversationId: resolver returns a foreign id not in candidates -> null", () => {
	// Safety: the resolver must not be able to bind us to a DB outside the
	// newly-created set. We ignore anything it returns that isn't a candidate.
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	fs.writeFileSync(path.join(dir, "ours.db"), "");
	fs.writeFileSync(path.join(dir, "theirs.db"), "");
	const lyingResolver: OpenDbResolver = () => "totally-unrelated";
	assert.equal(
		newConversationId(dir, before, { pid: 1, resolveOpenDb: lyingResolver }),
		null,
	);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newConversationId: resolver finds none -> null (fail safe)", () => {
	const dir = seed(["pre"]);
	const before = snapshotConversations(dir);
	fs.writeFileSync(path.join(dir, "ours.db"), "");
	fs.writeFileSync(path.join(dir, "theirs.db"), "");
	const emptyResolver: OpenDbResolver = () => null;
	assert.equal(newConversationId(dir, before, { pid: 1, resolveOpenDb: emptyResolver }), null);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("procTreeOpenDbResolver: returns null with <=1 candidate (nothing to disambiguate)", () => {
	assert.equal(procTreeOpenDbResolver(1, os.tmpdir(), new Set()), null);
	assert.equal(procTreeOpenDbResolver(1, os.tmpdir(), new Set(["only"])), null);
});
