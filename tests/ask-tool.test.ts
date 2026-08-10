// Tests for the AskAntigravity tool's catalog parsing and alias resolution.
//
// agy prints TWO columns per line: "<slug>  <display label>". --model takes
// only the slug (col 1); the label is display-only. Gemini bases split their
// tier out to a separate --effort (the base slug alone is invalid); fixed
// families (claude-*, gpt-oss-*) keep agy's exact slug with NO --effort.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveModel, toolModelsFromRaw } from "../src/ask-tool.js";

// The REAL `agy models` stdout shape (verified live via `ct agy models`).
const RAW = [
	"gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
	"gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
	"gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
	"gemini-3.5-flash-high     Gemini 3.5 Flash (High)",
	"gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)",
	"gemini-3.5-flash-low      Gemini 3.5 Flash (Low)",
	"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
	"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
	"claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
	"claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
	"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
].join("\n");

const entries = toolModelsFromRaw(RAW);
const DEFAULT_THINKING = "medium";

test("toolModelsFromRaw: splits the slug (col 1) off the display label", () => {
	// The label must never reach --model: full is the slug only.
	const flashHigh = entries.find((e) => e.full === "gemini-3.6-flash-high");
	assert.deepEqual(flashHigh, {
		full: "gemini-3.6-flash-high",
		family: "flash",
		version: "3.6",
		tier: "high",
	});

	// "-thinking" and a bare slug are NOT low/medium/high tiers.
	const opus = entries.find((e) => e.full === "claude-opus-4-6-thinking");
	assert.equal(opus?.tier, null);
	assert.equal(opus?.family, "other");
	const sonnet = entries.find((e) => e.full === "claude-sonnet-4-6");
	assert.equal(sonnet?.tier, null);
});

test("resolveModel: friendly alias splits Gemini base + default effort", () => {
	assert.deepEqual(resolveModel("flash", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "medium",
	});
	// Pro has no medium variant; its family default is high.
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
});

test("resolveModel: explicit tier and pinned version", () => {
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "high",
	});
	assert.deepEqual(resolveModel("3.5 flash low", entries, DEFAULT_THINKING), {
		model: "gemini-3.5-flash",
		effort: "low",
	});
});

test("resolveModel: short aliases resolve to valid agy slugs with NO effort", () => {
	// Fixed-thinking families: agy rejects --effort, so the slug carries any
	// tier suffix itself (gpt-oss-120b-medium) and effort is absent.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
	assert.deepEqual(resolveModel("opus", entries, DEFAULT_THINKING), {
		model: "claude-opus-4-6-thinking",
	});
	assert.deepEqual(resolveModel("gpt-oss", entries, DEFAULT_THINKING), {
		model: "gpt-oss-120b-medium",
	});
});

test("resolveModel: an exact tiered slug splits to base + effort (not passed whole)", () => {
	// Passing the whole tiered slug to --model is what agy rejects; the resolver
	// must split it exactly like an alias would.
	assert.deepEqual(resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "high",
	});
	// A fixed exact slug passes through unchanged.
	assert.deepEqual(resolveModel("claude-sonnet-4-6", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
});

test("resolveModel: short aliases still resolve when agy omits them (static overlay)", () => {
	// agy lists only Gemini here; the static overlay fills in the rest so the
	// aliases never regress to the old human-name format.
	const geminiOnly = toolModelsFromRaw(
		[
			"gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
			"gemini-3.6-flash-medium Gemini 3.6 Flash (Medium)",
			"gemini-3.6-flash-low    Gemini 3.6 Flash (Low)",
		].join("\n"),
	);
	assert.deepEqual(resolveModel("sonnet", geminiOnly, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
	assert.deepEqual(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), {
		model: "gpt-oss-120b-medium",
	});
});
