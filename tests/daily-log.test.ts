// Daily logger tests: rotation, retention, redaction, and the never-throw
// contract (a broken log dir must never disrupt a turn).

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDailyLogger } from "../src/daily-log.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-log-"));
}

function readLines(dir: string, file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(path.join(dir, file), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("daily log: writes NDJSON records with ts, level, event, data", async () => {
	const dir = tmpDir();
	const log = createDailyLogger({
		dir,
		debug: true,
		now: () => new Date(2026, 1, 5, 10, 30, 0),
	});
	log.log("turn-end", { status: "OK" }, "debug");
	log.log("spawn", { pid: 123 });
	await log.flush();

	const lines = readLines(dir, "2026-02-05.ndjson");
	assert.equal(lines.length, 2);
	assert.equal(lines[0].event, "turn-end");
	assert.equal(lines[0].level, "debug");
	assert.deepEqual(lines[0].data, { status: "OK" });
	assert.equal(typeof lines[0].ts, "string");
	// Default level is debug.
	assert.equal(lines[1].level, "debug");
});

test("daily log: rotates to a new file per local day", async () => {
	const dir = tmpDir();
	let day = 5;
	const log = createDailyLogger({
		dir,
		debug: true,
		now: () => new Date(2026, 1, day, 23, 59, 59),
	});
	log.log("first");
	day = 6;
	log.log("second");
	await log.flush();

	assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-02-05.ndjson", "2026-02-06.ndjson"]);
	assert.equal(readLines(dir, "2026-02-05.ndjson")[0].event, "first");
	assert.equal(readLines(dir, "2026-02-06.ndjson")[0].event, "second");
});

test("daily log: prunes files older than retention, keeps others", async () => {
	const dir = tmpDir();
	// 20 days old: pruned. Exactly at the 14-day cutoff: kept (>=). One day
	// past it: pruned. 2 days old: kept. Not a log file: kept.
	fs.writeFileSync(path.join(dir, "2026-01-16.ndjson"), "{}\n");
	fs.writeFileSync(path.join(dir, "2026-01-21.ndjson"), "{}\n");
	fs.writeFileSync(path.join(dir, "2026-01-22.ndjson"), "{}\n");
	fs.writeFileSync(path.join(dir, "2026-02-03.ndjson"), "{}\n");
	fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");

	const log = createDailyLogger({
		dir,
		retentionDays: 14,
		debug: true,
		now: () => new Date(2026, 1, 5),
	});
	log.log("today");
	await log.flush();

	assert.deepEqual(
		fs.readdirSync(dir).sort(),
		["2026-01-22.ndjson", "2026-02-03.ndjson", "2026-02-05.ndjson", "notes.txt"],
	);
});

test("daily log: redacts secret-shaped keys and truncates long strings", async () => {
	const dir = tmpDir();
	const log = createDailyLogger({ dir, debug: true, now: () => new Date(2026, 1, 5) });
	log.log("bridge-config", {
		apiKey: "SUP3RSECRET",
		nested: { authorization: "Bearer x", port: 4321 },
		headers: [{ name: "x-bridge-token", value: "BRIDGETOKEN123" }],
		big: "y".repeat(5000),
	});
	await log.flush();

	const raw = fs.readFileSync(path.join(dir, "2026-02-05.ndjson"), "utf8");
	assert.ok(!raw.includes("SUP3RSECRET"));
	assert.ok(!raw.includes("Bearer x"));
	assert.ok(!raw.includes("BRIDGETOKEN123"));
	const record = JSON.parse(raw) as { data: Record<string, unknown> };
	assert.equal(record.data.apiKey, "[redacted]");
	assert.equal(record.data.headers, "[redacted]");
	assert.deepEqual(record.data.nested, { authorization: "[redacted]", port: 4321 });
	assert.ok(String(record.data.big).endsWith("(truncated)"));
});

test("daily log: drops debug records unless verbose", async () => {
	const dir = tmpDir();
	const log = createDailyLogger({ dir, now: () => new Date(2026, 1, 5) });
	log.log("verbose-event"); // default level: debug -> dropped
	log.log("warn-event", undefined, "warn");
	log.log("info-event", undefined, "info");
	await log.flush();

	const events = readLines(dir, "2026-02-05.ndjson").map((l) => l.event);
	assert.deepEqual(events, ["warn-event", "info-event"]);
});

test("daily log: AGY_DEBUG env or debug option restores the verbose tier", async () => {
	const envDir = tmpDir();
	process.env.AGY_DEBUG = "1";
	try {
		const envLog = createDailyLogger({ dir: envDir, now: () => new Date(2026, 1, 5) });
		envLog.log("env-verbose");
		await envLog.flush();
		assert.deepEqual(readLines(envDir, "2026-02-05.ndjson").map((l) => l.event), ["env-verbose"]);
	} finally {
		delete process.env.AGY_DEBUG;
	}

	const optDir = tmpDir();
	const optLog = createDailyLogger({ dir: optDir, debug: true, now: () => new Date(2026, 1, 5) });
	optLog.log("opt-verbose");
	await optLog.flush();
	assert.deepEqual(readLines(optDir, "2026-02-05.ndjson").map((l) => l.event), ["opt-verbose"]);
});

test("daily log: oversized records are capped, payload dropped", async () => {
	const dir = tmpDir();
	const log = createDailyLogger({ dir, debug: true, now: () => new Date(2026, 1, 5) });
	// 50 capped strings of 2000 chars each: far over the 4000-byte line cap.
	log.log("huge", { rows: Array.from({ length: 50 }, (_, i) => String(i).padEnd(1999, "x")) });
	await log.flush();

	const raw = fs.readFileSync(path.join(dir, "2026-02-05.ndjson"), "utf8");
	assert.ok(raw.length <= 4001, `line capped, got ${raw.length}`);
	assert.ok(raw.includes("payload dropped"));
});

test("daily log: never throws when the dir cannot be created", async () => {
	const base = tmpDir();
	// A FILE where the directory should be: mkdir recursive fails.
	const blocker = path.join(base, "blocked");
	fs.writeFileSync(blocker, "not a dir");
	const log = createDailyLogger({ dir: blocker, debug: true, now: () => new Date(2026, 1, 5) });

	assert.doesNotThrow(() => log.log("event"));
	await log.flush(); // resolves despite the swallowed failure
});

test("daily log: recreates a deleted dir on the next record", async () => {
	const dir = tmpDir();
	const log = createDailyLogger({ dir, debug: true, now: () => new Date(2026, 1, 5) });
	log.log("before");
	await log.flush();
	fs.rmSync(dir, { recursive: true });
	log.log("after");
	await log.flush();

	const lines = readLines(dir, "2026-02-05.ndjson");
	// "before" died with the rm; the point is the dir was rebuilt and "after"
	// (previously lost with the append failure) landed.
	assert.deepEqual(lines.map((l) => l.event), ["after"]);
});
