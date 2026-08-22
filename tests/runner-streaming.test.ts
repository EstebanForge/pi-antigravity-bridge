// Regression guard for the streaming poll loop. A fake "agy" writes step rows
// to a real conversation DB on a delay; runAgyTurn must emit them as they
// land (spread across time), NOT all at once after the process exits.
//
// This is the test that would have caught the original bug where pollOnce was
// only invoked from the trailing-poll loop (post-exit), so nothing streamed
// during the run. It needs no network and no real agy install.
//
// Run: npx tsx --test tests/runner-streaming.test.ts

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runAgyTurn, type AgyEvent } from "../src/runner.js";

/** Build the fake agy binary: a Node script that creates a conversation DB
 *  in $AGY_FAKE_CONV_DIR, waits, inserts an agent-text step, waits again,
 *  inserts a second one, then exits 0. The two writes are ~400ms apart so a
 *  concurrent poller sees them at distinct times; a trailing-only poller
 *  would see both at exit. */
function writeFakeAgy(scriptPath: string, convDir: string): void {
	const script = `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dir = process.env.AGY_FAKE_CONV_DIR;
if (!dir) { console.error("AGY_FAKE_CONV_DIR unset"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an agentText step_payload: outer field 20 (submessage) wraps inner
// field 1 (string). Matches extractAgentText's field 20.1 navigation.
function agentText(text) {
  const textBytes = Buffer.from(text, "utf8");
  const inner = Buffer.concat([Buffer.from([0x0a, textBytes.length]), textBytes]);
  // field 20 wire 2 tag = (20<<3)|2 = 162 = varint [0xa2, 0x01]
  return Buffer.concat([Buffer.from([0xa2, 0x01, inner.length]), inner]);
}

await sleep(150); // let the runner's discovery snapshot settle
const dbPath = path.join(dir, randomUUID() + ".db");
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))");
const ins = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?,?,?,?)");

await sleep(300);
ins.run(0, 15, 3, agentText("chunk1 "));
await sleep(400);
ins.run(1, 15, 3, agentText("chunk2"));
db.close();
process.exit(0);
`;
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	void convDir;
}

test("runAgyTurn streams events during the run, not only at exit", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-"));
	const convDir = path.join(tmp, "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const fakeBin = path.join(tmp, "fake-agy.mjs");
	writeFakeAgy(fakeBin, convDir);

	const events: Array<{ event: AgyEvent; at: number }> = [];
	const start = Date.now();

	// Point both the runner's poller and the fake binary at the same temp dir.
	process.env.AGY_FAKE_CONV_DIR = convDir;

	const result = await runAgyTurn(
		{
			cwd: tmp,
			prompt: "ignored by fake",
			conversationsDir: convDir,
			binary: fakeBin,
			timeoutMin: 1,
		},
		(event) => events.push({ event, at: Date.now() - start }),
	);

	delete process.env.AGY_FAKE_CONV_DIR;

	const texts = events
		.filter((e) => e.event.kind === "text")
		.map((e) => ({ text: e.event.kind === "text" ? e.event.text : "", at: e.at }));

	assert.equal(result.exitCode, 0, "fake agy should exit 0");
	assert.equal(result.conversationId !== null, true, "conversation id should be discovered");
	assert.equal(texts.length, 2, `expected 2 text events, got ${texts.length}`);
	assert.equal(texts[0].text, "chunk1 ");
	assert.equal(texts[1].text, "chunk2");

	// THE regression assertion: the two events were emitted by polls DURING
	// the run, not both at once by a trailing-only poller. A trailing-only
	// poller reads both already-written rows in its first post-exit SELECT,
	// so the gap would be ~0ms. Working concurrent polling emits them at
	// distinct poll ticks (250ms apart), so any gap well above 0 proves it.
	// Threshold is deliberately loose: 250ms poll granularity + scheduler
	// jitter mean the observed gap can be a bit under the fake's 400ms write
	// spacing. The primary signal is the before-exit check below.
	const gap = texts[1].at - texts[0].at;
	assert.ok(
		gap >= 150,
		`expected >=150ms gap between streamed events (concurrent poll), got ${gap}ms (trailing-only would be ~0)`,
	);

	// Primary signal: the first event arrived BEFORE the process exited by a
	// clear margin. A trailing-only poller emits everything after exit, so the
	// first event would land at ~durationMs, not 100+ms before it.
	assert.ok(
		texts[0].at < result.durationMs - 150,
		`first event at ${texts[0].at}ms should precede exit at ${result.durationMs}ms by >150ms`,
	);

	fs.rmSync(tmp, { recursive: true, force: true });
	void randomUUID; // keep import meaningful if tree-shaken
});

test("runAgyTurn aborts promptly and skips trailing polls", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-abort-"));
	const convDir = path.join(tmp, "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	// A fake agy that sleeps far longer than the test. It must be killed.
	const fakeBin = path.join(tmp, "fake-agy-sleep.mjs");
	fs.writeFileSync(
		fakeBin,
		"#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 30000));\nprocess.exit(0);\n",
		{ mode: 0o755 },
	);

	const controller = new AbortController();
	const start = Date.now();
	// Abort well before the fake's 30s sleep finishes.
	const abortTimer = setTimeout(() => controller.abort(), 300);

	const result = await runAgyTurn(
		{
			cwd: tmp,
			prompt: "ignored",
			conversationsDir: convDir,
			binary: fakeBin,
			timeoutMin: 5,
			signal: controller.signal,
		},
		() => {
			/* no events expected from the sleeping fake */
		},
	);
	clearTimeout(abortTimer);
	const elapsed = Date.now() - start;

	assert.equal(result.aborted, true, "run should report aborted");
	assert.ok(
		elapsed < 5000,
		`abort should return within ~5s of the signal, took ${elapsed}ms (trailing polls or missed kill?)`,
	);

	fs.rmSync(tmp, { recursive: true, force: true });
});

// Regression guard for agy "two-phase writes" (observed on 1.1.18; the
// introducing version is unknown - not present in 1.1.7-era behavior):
// the agent-text row is FIRST committed as a metadata-only placeholder frame
// (status != 3, protobuf field 20 present but empty) and only later grows,
// in place, into its final content under the SAME idx. The old single-shot
// tracking armed only after a successful decode, so a null decode on first
// sight meant the row was skipped forever - pi showed an empty response even
// though the settled DB held perfect text (decode-db proved it).
test("runAgyTurn streams text from a two-phase placeholder -> filled row", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-two-phase-"));
	const convDir = path.join(tmp, "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const fakeBin = path.join(tmp, "fake-agy-two-phase.mjs");
	const script = `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dir = process.env.AGY_FAKE_CONV_DIR;
if (!dir) { console.error("AGY_FAKE_CONV_DIR unset"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentText(text) {
  const textBytes = Buffer.from(text, "utf8");
  const inner = Buffer.concat([Buffer.from([0x0a, textBytes.length]), textBytes]);
  return Buffer.concat([Buffer.from([0xa2, 0x01, inner.length]), inner]);
}

// Placeholder frame captured live from agy 1.1.18: step_type=15 (field 1),
// status=8/in-flight (field 4), field 20 present but EMPTY.
function placeholderFrame() {
  return Buffer.from([0x08, 0x0f, 0x20, 0x08, 0xa2, 0x01, 0x00]);
}

await sleep(150);
const dbPath = path.join(dir, randomUUID() + ".db");
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))");
const ins = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?,?,?,?)");

await sleep(300);
ins.run(0, 15, 8, placeholderFrame()); // phase 1: decodes to null
await sleep(400);
db.prepare("UPDATE steps SET status = ?, step_payload = ? WHERE idx = 0")
  .run(3, agentText("recovered tail")); // phase 2: same row grows in place
db.close();
process.exit(0);
`;
	fs.writeFileSync(fakeBin, script, { mode: 0o755 });

	process.env.AGY_FAKE_CONV_DIR = convDir;
	const events: AgyEvent[] = [];
	const result = await runAgyTurn(
		{
			cwd: tmp,
			prompt: "ignored by fake",
			conversationsDir: convDir,
			binary: fakeBin,
			timeoutMin: 1,
		},
		(event) => events.push(event),
	);
	delete process.env.AGY_FAKE_CONV_DIR;

	const texts = events
		.filter((e): e is Extract<AgyEvent, { kind: "text" }> => e.kind === "text")
		.map((e) => e.text)
		.join("");

	assert.equal(result.exitCode, 0, "fake agy should exit 0");
	assert.equal(result.lastIdx, 0, "should have seen the placeholder row");
	assert.equal(
		texts,
		"recovered tail",
		`placeholder frame's eventual content must be streamed, got ${JSON.stringify(texts)}`,
	);
	assert.equal(
		events.filter((e) => e.kind === "warning").length,
		0,
		"no warning when text was successfully decoded",
	);

	fs.rmSync(tmp, { recursive: true, force: true });
});

// Turn-end diagnostics: if agy completes agent-text
// rows but NONE of them decode (a future layout shift), the caller gets one
// visible warning instead of a silently empty response.
test("runAgyTurn warns once when completed text rows never decode", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-undecodable-"));
	const convDir = path.join(tmp, "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const fakeBin = path.join(tmp, "fake-agy-undecodable.mjs");
	const script = `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dir = process.env.AGY_FAKE_CONV_DIR;
if (!dir) { console.error("AGY_FAKE_CONV_DIR unset"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(150);
const dbPath = path.join(dir, randomUUID() + ".db");
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))");
const ins = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?,?,?,?)");

await sleep(300);
// Complete agent-text row (status=3) whose payload has NO field 20 - i.e. a
// layout this bridge's extractor cannot navigate.
ins.run(0, 15, 3, Buffer.from([0x08, 0x0f, 0x20, 0x03, 0x2a, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]));
db.close();
process.exit(0);
`;
	fs.writeFileSync(fakeBin, script, { mode: 0o755 });

	process.env.AGY_FAKE_CONV_DIR = convDir;
	const events: AgyEvent[] = [];
	const result = await runAgyTurn(
		{
			cwd: tmp,
			prompt: "ignored by fake",
			conversationsDir: convDir,
			binary: fakeBin,
			timeoutMin: 1,
		},
		(event) => events.push(event),
	);
	delete process.env.AGY_FAKE_CONV_DIR;

	const warnings = events.filter((e) => e.kind === "warning");
	assert.equal(result.exitCode, 0, "fake agy should exit 0");
	assert.equal(
		events.filter((e) => e.kind === "text").length,
		0,
		"undecodable row must not produce text",
	);
	assert.equal(warnings.length, 1, `expected exactly 1 warning, got ${warnings.length}`);

	fs.rmSync(tmp, { recursive: true, force: true });
});
