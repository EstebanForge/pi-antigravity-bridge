// Unit tests for the narration filter. Pure function, no I/O.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import { isNarration, isNarrationLine } from "../src/narration.js";

// --- drops: short agentic intent lines -------------------------------

test("isNarration: true for short intent lines with an agentic verb", () => {
	assert.equal(isNarration("I will read the file."), true);
	assert.equal(isNarration("I'll check the types."), true);
	assert.equal(isNarration("I will search for the function."), true);
	assert.equal(isNarration("I'll edit src/index.ts."), true);
	assert.equal(isNarration("I'll run the tests."), true);
	assert.equal(isNarration("I\u2019ll view the logs."), true); // curly apostrophe
});

test("isNarration: true when EVERY line is narration (multi-line all-narration)", () => {
	assert.equal(isNarration("I will read the file.\nI'll check the types."), true);
});

test("isNarration: leading whitespace before the prefix still counts", () => {
	// agy sometimes indents narration; the filter strips leading whitespace
	// before matching so indented "I will ..." lines are still dropped.
	assert.equal(isNarration("  I will check."), true);
});

// --- keeps: substantive answers that merely start with "I will" ------

test("isNarration: false for explanation / saying verbs after the prefix", () => {
	// The core fix: these used to be dropped because they start with the prefix.
	assert.equal(isNarration("I will explain the three main causes:"), false);
	assert.equal(isNarration("I'll demonstrate: 2+2=4"), false);
	assert.equal(isNarration("I'll summarize the findings."), false);
	assert.equal(isNarration("I will assume the input is hostile."), false);
	assert.equal(isNarration("I'll disagree with that claim."), false);
	assert.equal(isNarration("I'll start with the conclusion."), false);
});

test("isNarration: action-verb intent is narration at any length", () => {
	// No length ceiling: the doing/saying verb split is the whole signal. A long
	// line that is still pure intent ("I will read ... and address ...") is
	// narration; length alone never rescues it.
	assert.equal(
		isNarration("I will read through the module and address each point in the review."),
		true,
	);
});

test("isNarration: false when any line is not narration (mixed)", () => {
	assert.equal(isNarration("I will read the file.\nHere is the summary."), false);
	// A saying-verb second line now makes the chunk non-narration (it is kept).
	assert.equal(isNarration("I will read the file.\nI'll summarize it."), false);
	assert.equal(isNarration("The answer is 42."), false);
});

test("isNarration: false on empty / whitespace-only text", () => {
	assert.equal(isNarration(""), false);
	assert.equal(isNarration("   \n\n  "), false);
});

test("isNarration: prefix must hit a word boundary (no mid-word false match)", () => {
	assert.equal(isNarration("I willpower through this."), false);
	assert.equal(isNarration("I'llx be there."), false);
});

test("isNarration: bare prefix with no verb after is kept", () => {
	assert.equal(isNarration("I will"), false);
});

// --- isNarrationLine: direct unit tests for the verb/length logic ----

test("isNarrationLine: verb match is case-insensitive", () => {
	assert.equal(isNarrationLine("I will Read the file."), true);
});

test("isNarrationLine: trailing punctuation on the verb is stripped", () => {
	assert.equal(isNarrationLine("I will check:"), true);
	assert.equal(isNarrationLine("I'll edit,"), true);
});
