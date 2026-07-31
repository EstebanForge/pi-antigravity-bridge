// Tests for the AskAntigravity tool's catalog parsing and alias resolution,
// against agy's stable-slug catalog format (gemini-3.6-flash-high,
// claude-sonnet-4-6, gpt-oss-120b-medium). These guard the migration off the
// legacy "Gemini 3.6 Flash (Medium)" human-name format. Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveModel, toolModelsFromRaw } from "../src/ask-tool.js";

// The real `agy models` output shape: stable slugs, one per line.
const RAW = [
	"gemini-3.6-flash-high",
	"gemini-3.6-flash-medium",
	"gemini-3.6-flash-low",
	"gemini-3.5-flash-high",
	"gemini-3.5-flash-medium",
	"gemini-3.5-flash-low",
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b-medium",
].join("\n");

const entries = toolModelsFromRaw(RAW);
const DEFAULT_THINKING = "medium";

test("toolModelsFromRaw: parses slug families, versions, and suffix tiers", () => {
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

test("resolveModel: friendly alias resolves to latest version + default tier", () => {
	assert.equal(resolveModel("flash", entries, DEFAULT_THINKING), "gemini-3.6-flash-medium");
	// Pro has no medium variant; its family default is high.
	assert.equal(resolveModel("pro", entries, DEFAULT_THINKING), "gemini-3.1-pro-high");
});

test("resolveModel: explicit tier and pinned version", () => {
	assert.equal(resolveModel("flash high", entries, DEFAULT_THINKING), "gemini-3.6-flash-high");
	assert.equal(resolveModel("3.5 flash low", entries, DEFAULT_THINKING), "gemini-3.5-flash-low");
});

test("resolveModel: short aliases resolve to valid agy slugs", () => {
	assert.equal(resolveModel("sonnet", entries, DEFAULT_THINKING), "claude-sonnet-4-6");
	assert.equal(resolveModel("opus", entries, DEFAULT_THINKING), "claude-opus-4-6-thinking");
	assert.equal(resolveModel("gpt-oss", entries, DEFAULT_THINKING), "gpt-oss-120b-medium");
});

test("resolveModel: an exact slug passes through unchanged", () => {
	assert.equal(
		resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING),
		"gemini-3.6-flash-high",
	);
	assert.equal(resolveModel("claude-sonnet-4-6", entries, DEFAULT_THINKING), "claude-sonnet-4-6");
});

test("resolveModel: short aliases still resolve when agy omits them (static overlay)", () => {
	// agy lists only Gemini here; the static overlay fills in the rest so the
	// aliases never regress to the old human-name format.
	const geminiOnly = toolModelsFromRaw(
		"gemini-3.6-flash-high\ngemini-3.6-flash-medium\ngemini-3.6-flash-low",
	);
	assert.equal(resolveModel("sonnet", geminiOnly, DEFAULT_THINKING), "claude-sonnet-4-6");
	assert.equal(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), "gpt-oss-120b-medium");
});
