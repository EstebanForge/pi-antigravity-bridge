// Provider integration test: drive createStreamSimple directly (no pi TUI),
// iterate the AssistantMessageEventStream, and assert the event sequence +
// streamed text. Exercises the full pipeline: provider -> runner -> poller ->
// protobuf -> discovery, against a REAL agy run.
//
// Usage: npx tsx scripts/test-provider.ts

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type Api,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyModelEntry } from "../src/models.js";

const AGY_STRING = "Gemini 3.6 Flash (Medium)";
const entries: AgyModelEntry[] = [{ full: AGY_STRING, id: "gemini-flash" }];

// Build a pi Model that points at our provider. The streamSimple closure
// resolves model.id -> the agy string via `entries`.
const model: Model<Api> = {
	id: "gemini-flash",
	name: AGY_STRING,
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const context: Context = {
	systemPrompt: undefined,
	messages: [
		{
			role: "user",
			content: "Reply with exactly: PROVIDER_OK. Nothing else.",
			timestamp: Date.now(),
		},
	],
};

// Use a throwaway session store so this test never clobbers real state.
const tmpStore = new SessionStore(`/tmp/antigravity-test-${process.pid}-sessions.json`);
const streamSimple = createStreamSimple({
	entries,
	store: tmpStore,
});

const events: AssistantMessageEvent[] = [];
const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);

for await (const ev of stream) {
	events.push(ev);
}

// --- assertions -------------------------------------------------------------

const types: string[] = events.map((e) => e.type);
const has = (t: string) => types.includes(t);

const textDeltas = events.filter(
	(e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta",
);
const streamedText = textDeltas.map((e) => e.delta).join("");
const done = events.find(
	(e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done",
);
const finalMessage: AssistantMessage | undefined = done?.message;
const finalText =
	finalMessage?.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ??
	"";

let failures = 0;
const check = (label: string, cond: boolean) => {
	const tag = cond ? "PASS" : "FAIL";
	if (!cond) failures++;
	console.log(`  ${tag}  ${label}`);
};

console.log("provider integration test");
console.log(`  events: ${types.join(" -> ")}`);
check("got a start event", has("start"));
check("start is the FIRST event (not lazy)", types[0] === "start");
check("got text_start", has("text_start"));
check(`got >=1 text_delta (got ${textDeltas.length})`, textDeltas.length >= 1);
check("got text_end", has("text_end"));
check("terminal event is done (not error)", has("done") && !has("error"));
check("streamed text is non-empty", streamedText.length > 0);
check("final message stopReason is stop", finalMessage?.stopReason === "stop");
check("final text block matches streamed deltas", finalText === streamedText);
check("response contains PROVIDER_OK", streamedText.includes("PROVIDER_OK"));

console.log("");
console.log(`streamed text (${streamedText.length} chars):`);
console.log(streamedText.slice(0, 500));
console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

// Reference createAssistantMessageEventStream so the import isn't elided
// (documents the factory we rely on inside provider.ts).
void createAssistantMessageEventStream;
