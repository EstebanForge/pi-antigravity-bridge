// Unit tests for ConversationPoller coalescing.
//
// Proves the data_version gate works: a second poll() with no intervening
// commit returns [] (no SELECT on the steps table runs), and commits from a
// SEPARATE writer connection (the agy side) are what unblock the next read.
// This is the contract the runner relies on to skip readStepAt/readNewSteps
// on idle ticks.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConversationPoller } from "../src/poller.js";

/** Build a conversations DB with a steps table and return a writer handle plus
 *  the path. The poller opens its own read-only handle to the same file. */
function makeDb(): { dbPath: string; writer: DatabaseSync; insert: (idx: number) => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-poll-"));
	const dbPath = path.join(dir, "conv.db");
	const writer = new DatabaseSync(dbPath);
	writer.exec(
		"CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, " +
			"status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))",
	);
	const ins = writer.prepare(
		"INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)",
	);
	// Payload bytes are opaque for these tests; the poller returns the raw blob.
	const insert = (idx: number): void => void ins.run(idx, 15, Buffer.from([0x0a, 0x01, 0x2a]));
	insert(0);
	return { dbPath, writer, insert };
}

test("poll: first call returns the row, second call with no commit returns []", () => {
	const { dbPath, writer } = makeDb();
	const poller = new ConversationPoller(dbPath, -1);
	assert.equal(poller.isOpen, true);

	const first = poller.poll();
	assert.equal(first.length, 1);
	assert.equal(first[0]?.idx, 0);

	// No commit since the first poll -> data_version unchanged -> coalesced out.
	const second = poller.poll();
	assert.equal(second.length, 0);

	poller.close();
	writer.close();
});

test("poll: a commit from a separate writer connection unblocks the next read", () => {
	const { dbPath, writer, insert } = makeDb();
	const poller = new ConversationPoller(dbPath, -1);
	poller.poll(); // drain row 0, capture data_version

	assert.equal(poller.poll().length, 0); // still idle

	insert(1); // writer commits -> data_version bumps on the reader's connection
	const after = poller.poll();
	assert.equal(after.length, 1);
	assert.equal(after[0]?.idx, 1);
	assert.equal(poller.poll().length, 0); // coalesced again until next commit

	poller.close();
	writer.close();
});

test("hasChanged/readNewSteps split: gate holds, then releases on commit", () => {
	const { dbPath, writer, insert } = makeDb();
	const poller = new ConversationPoller(dbPath, -1);

	// Drain the seed row so lastDataVersion is set and cursor advances past 0.
	assert.equal(poller.poll().length, 1);

	// Idle: hasChanged is false, so readNewSteps should not be relied on.
	assert.equal(poller.hasChanged(), false);

	insert(2);
	assert.equal(poller.hasChanged(), true); // commit landed
	const steps = poller.readNewSteps(); // read WITHOUT re-checking
	assert.equal(steps.length, 1);
	assert.equal(steps[0]?.idx, 2);
	// Cursor advanced; data_version already consumed by the hasChanged call.
	assert.equal(poller.hasChanged(), false);

	poller.close();
	writer.close();
});

test("poll: returns [] when the DB has no steps table (not yet flushed)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-poll-"));
	const dbPath = path.join(dir, "empty.db");
	const writer = new DatabaseSync(dbPath); // no steps table created
	const poller = new ConversationPoller(dbPath, -1);
	assert.equal(poller.isOpen, false);
	assert.equal(poller.poll().length, 0);
	poller.close();
	writer.close();
});
