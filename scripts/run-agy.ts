// Standalone streaming CLI: spawn agy -p, poll its DB, print decoded events
// to stdout AS THEY ARRIVE. Proves the streaming pipeline works outside pi.
//
// Usage:
//   npm run run-agy -- "Say hello in one sentence"
//   npm run run-agy -- --model "Gemini 3.6 Flash (Medium)" "What is 2+2?"
//   npm run run-agy -- --mode plan "Review this file: src/protobuf.ts"
//   npm run run-agy -- --conversation <uuid> "follow up"
//   npm run run-agy -- --cwd /tmp/somedir "list files here"
//
// Acceptance: text appears incrementally (timestamps tick), not all at once
// after agy exits. A final summary prints the conversation id + step count.

import { runAgyTurn, type AgyEvent } from "../src/runner.js";

function usage(): never {
	console.error(
		[
			"usage: run-agy [--model NAME] [--mode plan|accept-edits]",
			"               [--conversation UUID] [--cwd DIR] [--timeout-min N]",
			"               <prompt>",
		].join("\n"),
	);
	process.exit(1);
}

interface Args {
	model?: string;
	mode?: "plan" | "accept-edits";
	conversation?: string;
	cwd?: string;
	timeoutMin?: number;
	prompt: string;
}

function parseArgs(argv: string[]): Args {
	const out: Partial<Args> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--model":
				out.model = argv[++i];
				break;
			case "--mode": {
				const m = argv[++i] as "plan" | "accept-edits";
				if (m !== "plan" && m !== "accept-edits") {
					console.error(`--mode must be plan or accept-edits, got: ${m}`);
					process.exit(1);
				}
				out.mode = m;
				break;
			}
			case "--conversation":
				out.conversation = argv[++i];
				break;
			case "--cwd":
				out.cwd = argv[++i];
				break;
			case "--timeout-min":
				out.timeoutMin = Number(argv[++i]);
				break;
			case "--help":
			case "-h":
				usage();
			default:
				positional.push(a);
		}
	}
	const prompt = positional.join(" ").trim();
	if (!prompt) usage();
	return { ...out, prompt } as Args;
}

const args = parseArgs(process.argv.slice(2));

const cwd = args.cwd || process.cwd();
const start = Date.now();

// Timestamped print so the user can SEE events arriving over time (the whole
// point of Phase 2: streaming, not batched-at-exit).
const stamp = () => {
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	return `[${elapsed.padStart(5)}s]`;
};

let textChars = 0;
let toolCount = 0;

const onEvent = (event: AgyEvent) => {
	switch (event.kind) {
		case "text":
			// Stream text immediately  -  no buffering. process.stdout.write to
			// avoid the newline that console.log adds.
			process.stdout.write(event.text);
			textChars += event.text.length;
			break;
		case "thinking":
			process.stdout.write(`\n${stamp()} (thinking) ${event.text}\n`);
			break;
		case "tool":
			toolCount++;
			// One-line tool activity marker, mirroring what the provider will
			// surface in pi as a thinking-style event.
			process.stdout.write(`\n${stamp()} [agy tool: ${event.name}]\n`);
			break;
		case "title":
			// Title updates are metadata; note but don't clutter the stream.
			break;
	}
};

console.log(`${stamp()} agy starting (model=${args.model ?? "default"}, mode=${args.mode ?? "accept-edits"})`);
console.log(`${stamp()} cwd: ${cwd}`);
console.log(`${stamp()} prompt: ${args.prompt.slice(0, 100)}${args.prompt.length > 100 ? "…" : ""}`);
console.log("---");

const result = await runAgyTurn(
	{
		cwd,
		model: args.model,
		mode: args.mode,
		prompt: args.prompt,
		conversationId: args.conversation,
		timeoutMin: args.timeoutMin,
	},
	onEvent,
);

console.log("\n---");
console.log(
	[
		`${stamp()} done in ${(result.durationMs / 1000).toFixed(1)}s`,
		`exit=${result.exitCode}`,
		`text=${textChars}c`,
		`tools=${toolCount}`,
		`lastIdx=${result.lastIdx}`,
		result.aborted ? "ABORTED" : "",
		result.timedOut ? "TIMED_OUT" : "",
	]
		.filter(Boolean)
		.join("  "),
);
if (result.conversationId) {
	console.log(`conversationId: ${result.conversationId}`);
	console.log("  (pass as --conversation to resume)");
}
if (result.stderr.trim()) {
	console.error(`stderr:\n${result.stderr.trim().slice(0, 2000)}`);
}
process.exit(result.exitCode === 0 && !result.timedOut ? 0 : 1);
