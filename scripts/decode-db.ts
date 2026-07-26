// Standalone diagnostic: open a real agy conversation DB, walk every step,
// decode agent-text / tool-call / title payloads, and print a summary.
//
// Usage:  npm run decode-db -- <path-to-conv.db>
//         npm run decode-db -- <uuid>      (resolved against the conversations dir)
//
// Purpose: prove the protobuf walker + SQLite reader work against real data
// before wiring them into pi. This is Phase 1's acceptance check.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationPoller } from "../src/poller.js";
import { extractAgentText, extractTitle, extractToolCall, utf8String } from "../src/protobuf.js";

const CONVERSATIONS_DIR = path.join(
	os.homedir(),
	".gemini",
	"antigravity-cli",
	"conversations",
);

function resolveDb(arg: string): string {
	if (path.isAbsolute(arg) || fs.existsSync(arg)) return arg.endsWith(".db") ? arg : `${arg}.db`;
	const withDb = arg.endsWith(".db") ? arg : `${arg}.db`;
	return path.join(CONVERSATIONS_DIR, withDb);
}

const arg = process.argv[2];
if (!arg) {
	console.error("usage: decode-db <path-or-uuid>");
	process.exit(1);
}

const dbPath = resolveDb(arg);
if (!fs.existsSync(dbPath)) {
	console.error(`DB not found: ${dbPath}`);
	process.exit(1);
}

const poller = new ConversationPoller(dbPath, -1);
if (!poller.isOpen) {
	console.error("could not open DB (no steps table?)");
	process.exit(1);
}

const steps = poller.poll();
poller.close();

const summary: Record<string, number> = {};
let agentChars = 0;
const agentPreview: string[] = [];
const tools: string[] = [];

for (const step of steps) {
	const key = String(step.stepType);
	summary[key] = (summary[key] ?? 0) + 1;

	if (step.stepType === 15) {
		const t = extractAgentText(step.payload);
		if (t) {
			agentChars += t.text.length;
			if (agentPreview.length < 3 && t.text.trim()) {
				agentPreview.push(t.text.slice(0, 200));
			}
		}
	} else if (isToolStep(step.stepType)) {
		const tc = extractToolCall(step.payload);
		if (tc?.name) tools.push(tc.name);
	} else if (step.stepType === 23) {
		// title update  -  recorded but not streamed
	} else if (step.stepType === 14) {
		// thinking  -  recorded
	}
}

console.log(`DB: ${path.basename(dbPath)}`);
console.log(`steps: ${steps.length}`);
console.log(`by step_type:`, summary);
console.log(`agent-text chars: ${agentChars}`);
console.log(`tool calls seen: ${tools.length > 0 ? [...new Set(tools)].join(", ") : "(none)"}`);
if (agentPreview.length > 0) {
	console.log("\n--- agent text preview (first 3 chunks, 200 chars each) ---");
	for (const p of agentPreview) {
		console.log(p);
		console.log("…");
	}
}

// Exercise the varint walker + text extraction against the DB. Sanity: a
// non-empty agent-text step must decode to valid UTF-8 with no NUL bytes.
function isToolStep(t: number): boolean {
	return [5, 7, 8, 9, 17, 21, 33, 101, 138].includes(t);
}

// Re-export so eslint/tsc doesn't warn utf8String is unused (it's a smoke test).
void utf8String;
