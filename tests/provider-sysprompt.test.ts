// Unit tests for buildFullPrompt (src/provider.ts).
//
// G10: pi's composed system prompt (operating instructions + AGENTS.md files)
// is prepended as a delimited block on the FIRST prompt of a fresh agy
// conversation. Pure function: no I/O. Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	SYSTEM_PROMPT_END,
	SYSTEM_PROMPT_PREAMBLE,
	ToolRoundTrips,
	buildFullPrompt,
	createStreamSimple,
} from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyDriver, DriverTurnRequest } from "../src/driver.js";

const SYS = "You are pi. Follow AGENTS.md.";

test("fresh conversation: system prompt block is prepended", () => {
	const out = buildFullPrompt(SYS, "", "hello");
	assert.ok(out.startsWith(SYSTEM_PROMPT_PREAMBLE));
	assert.ok(out.includes(SYS));
	assert.ok(out.endsWith(`${SYSTEM_PROMPT_END}\n\n---\n\nhello`));
	// Delimiters wrap exactly one block.
	assert.equal(out.split(SYSTEM_PROMPT_PREAMBLE).length, 2);
	assert.equal(out.split(SYSTEM_PROMPT_END).length, 2);
});

test("no system prompt: plain passthrough (disabled or absent)", () => {
	// The call site passes undefined when config.systemPrompt is off or the
	// conversation is already bound.
	assert.equal(buildFullPrompt(undefined, "", "hello"), "hello");
});

test("empty-string system prompt is treated as absent", () => {
	assert.equal(buildFullPrompt("", "", "hello"), "hello");
});

test("order: system prompt block, then digest, then user prompt", () => {
	const out = buildFullPrompt(SYS, "[pi compaction summary]\nwe chose sqlite", "do it");
	const iSys = out.indexOf(SYS);
	const iDigest = out.indexOf("we chose sqlite");
	const iPrompt = out.indexOf("do it");
	assert.ok(iSys >= 0 && iDigest > iSys && iPrompt > iDigest);
});

test("digest without system prompt keeps digest preamble + prompt", () => {
	const out = buildFullPrompt(undefined, "digest-body", "hello");
	assert.ok(out.includes("\n\ndigest-body\n\n---\n\nhello"));
});

// --- G10 gating (fresh-vs-bound conversation) --------------------------------
// buildFullPrompt is pure; the DECISION lives in runTurnDriver
// (config.systemPrompt && !existing?.conversationId). Drive the real
// streamSimple with a fake driver whose outcome carries a conversationId and
// assert on the actual prompt handed to driver.run.

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

function contextWith(prompt: string, systemPrompt?: string): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
}

interface Harness {
	seen: { opts?: DriverTurnRequest };
	streamSimple: ReturnType<typeof createStreamSimple>;
	dir: string;
}

function gateHarness(): Harness {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver: AgyDriver = {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
					conversationId: "conv-g10",
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as AgyDriver;
	// One tmp dir = one stable session key (cwd-based) across both turns.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sysprompt-"));
	const streamSimple = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store: new SessionStore(path.join(dir, "sessions.json")),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return { seen, streamSimple, dir };
}

async function runTurn(h: Harness, prompt: string, systemPrompt?: string): Promise<void> {
	const stream = h.streamSimple(
		model,
		contextWith(prompt, systemPrompt),
		{ cwd: h.dir } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
}

function withSysEnv(value: string, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.AGY_SYSTEM_PROMPT;
	process.env.AGY_SYSTEM_PROMPT = value;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.AGY_SYSTEM_PROMPT;
		else process.env.AGY_SYSTEM_PROMPT = prev;
	});
}

test("gate: first turn of a fresh conversation prepends the system prompt block", async () => {
	await withSysEnv("on", async () => {
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			const prompt = h.seen.opts?.prompt ?? "";
			assert.ok(prompt.startsWith(SYSTEM_PROMPT_PREAMBLE));
			assert.ok(prompt.includes(SYS));
			assert.ok(prompt.endsWith(`${SYSTEM_PROMPT_END}\n\n---\n\nhello`));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("gate: bound conversation does not re-send the block", async () => {
	await withSysEnv("on", async () => {
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			await runTurn(h, "turn two", SYS);
			// Turn 1 bound conv-g10 via the outcome; turn 2 must ride agy's own
			// history with the bare user message only.
			assert.equal(h.seen.opts?.prompt, "turn two");
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

test("gate: systemPrompt off suppresses the block even on a fresh conversation", async () => {
	await withSysEnv("off", async () => {
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			assert.equal(h.seen.opts?.prompt, "hello");
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
