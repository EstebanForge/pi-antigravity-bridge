// Unit tests for the Gate B usage estimator (pure math, no server).

import { describe, expect, test } from "vitest";
import { estimateTokens, synthesizeUsage } from "../src/acp/usage-estimate.js";

describe("estimateTokens", () => {
	test("counts word runs and single punctuation, skips whitespace", () => {
		// "Hello" + "," + "world" + "!" = 4 matches
		expect(estimateTokens("Hello, world!")).toBe(4);
		expect(estimateTokens("  spaced   out  ")).toBe(2);
		expect(estimateTokens("")).toBe(0);
	});

	test("CJK: one match per character (inherent to the copied mechanism)", () => {
		expect(estimateTokens("日本語")).toBe(3);
	});
});

describe("synthesizeUsage", () => {
	const base = {
		prompt: "one two three",
		textTokens: 2,
		thoughtTokens: 1,
		textDeltas: 2,
		thoughtDeltas: 1,
	};

	test("estimate mode: regex over prompt + response + thought", () => {
		const u = synthesizeUsage({ ...base, mode: "estimate" });
		expect(u).toEqual({
			input_tokens: 3,
			output_tokens: 3, // response 2 + thought 1
			thinking_tokens: 1,
			total_tokens: 6,
		});
	});

	test("context block text counts toward input", () => {
		const u = synthesizeUsage({ ...base, mode: "estimate", contextText: "alpha beta" });
		expect(u?.input_tokens).toBe(5);
		expect(u?.total_tokens).toBe(8);
	});

	test("direct mode: 1 token per streamed delta", () => {
		const u = synthesizeUsage({ ...base, mode: "direct" });
		expect(u).toMatchObject({
			input_tokens: 3, // input is always regex-estimated
			output_tokens: 3, // 2 text deltas + 1 thought delta
			thinking_tokens: 1,
		});
	});

	test("off mode: undefined", () => {
		expect(synthesizeUsage({ ...base, mode: "off" })).toBeUndefined();
	});

	test("empty turn: undefined (nothing worth reporting)", () => {
		expect(
			synthesizeUsage({
				mode: "estimate",
				prompt: "",
				textTokens: 0,
				thoughtTokens: 0,
				textDeltas: 0,
				thoughtDeltas: 0,
			}),
		).toBeUndefined();
	});
});
