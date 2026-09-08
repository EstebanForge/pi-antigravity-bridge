// Gate B stopgap: synthesize AgyUsage for ACP turns until Google ships a
// real token-usage layer in agy_acp_server. Counting mechanism copied from
// the pi-token-speed extension (npm:pi-token-speed, src/engine.ts): a
// word/punctuation regex, 1 match = 1 token. The numbers are client-side
// ESTIMATES, never provider data: the connection's usageSeen latch (Gate B
// watch) keeps synthesis off the day real usage appears in any frame, so
// estimates can never shadow real numbers.

import type { UsageEstimate } from "../config.js";
import type { AgyUsage } from "../driver-types.js";

const TOKEN_REGEX = /\w+|[^\s\w]/g;

/** Word-boundary token estimate (pi-token-speed's estimateTokens). */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	const matches = text.match(TOKEN_REGEX);
	return matches ? matches.length : 0;
}

export interface UsageEstimateInput {
	mode: UsageEstimate;
	/** Full outgoing prompt text (input side; always regex-estimated). */
	prompt: string;
	/** ACP embeddedContext resource text (G1 digest): also reaches the model. */
	contextText?: string;
	/** Per-delta token sums (mode "estimate"). Summing per delta, like
	 *  pi-token-speed's recordDelta, avoids word-merge artifacts when a
	 *  chunk boundary splits a word. */
	textTokens: number;
	thoughtTokens: number;
	/** Streamed delta counts (mode "direct": 1 token per delta). */
	textDeltas: number;
	thoughtDeltas: number;
}

/** Synthesize usage for a finished turn, or undefined when nothing is worth
 *  reporting (mode off, or a turn with no prompt and no output). */
export function synthesizeUsage(input: UsageEstimateInput): AgyUsage | undefined {
	if (input.mode === "off") return undefined;
	const inputTokens = estimateTokens(
		input.contextText ? `${input.prompt}\n${input.contextText}` : input.prompt,
	);
	const thoughtTokens =
		input.mode === "direct" ? input.thoughtDeltas : input.thoughtTokens;
	const textTokens =
		input.mode === "direct" ? input.textDeltas : input.textTokens;
	// Thinking folds INTO output (OpenAI convention: reasoning tokens bill as
	// output). toPiUsage drops thinking_tokens, and thinking time is inside
	// elapsed wall time, so folding keeps the tokens/time ratio honest.
	const outputTokens = textTokens + thoughtTokens;
	if (inputTokens === 0 && outputTokens === 0) return undefined;
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		thinking_tokens: thoughtTokens,
		total_tokens: inputTokens + outputTokens,
	};
}
