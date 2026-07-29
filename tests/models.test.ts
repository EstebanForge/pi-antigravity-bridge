// Unit tests for the models catalog cache (src/models.ts).
//
// Covers read/writeModelsCache round-trip + validation, and the three
// loadModelCatalogRaw branches (fresh -> no spawn, no-cache -> spawn + persist,
// stale -> serve cached + background refresh). Spawning uses a temp fake `agy`
// binary so no real agy is needed.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	loadModelCatalogRaw,
	MODELS_CACHE_TTL_MS,
	refreshModelsInBackground,
} from "../src/models.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Temp cache path unique per test (avoids touching the real user cache). */
function tempCachePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-cache-")), "models-cache.json");
}

/** A fake `agy` binary that prints `output` (ignoring args), executable. */
function makeFakeAgy(output: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-"));
	const bin = path.join(dir, "agy");
	// printf so embedded newlines/quotes survive; no trailing newline (the
	// cache logic under test is newline-agnostic; entriesFromRaw trims anyway).
	fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\n`, {
		mode: 0o755,
	});
	return bin;
}

/** Read raw field from a cache file, or null if missing/unparseable. */
function readCacheRaw(cachePath: string): string | null {
	try {
		return (JSON.parse(fs.readFileSync(cachePath, "utf8")) as { raw?: string }).raw ?? null;
	} catch {
		return null;
	}
}

/** Poll a cache file until its raw matches `expected`, or fail after timeout. */
async function waitForCacheRaw(cachePath: string, expected: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readCacheRaw(cachePath) === expected) return;
		await sleep(20);
	}
	assert.fail(`cache did not update to ${JSON.stringify(expected)} (got ${JSON.stringify(readCacheRaw(cachePath))})`);
}

// --- TTL constant -----------------------------------------------------------

test("MODELS_CACHE_TTL_MS is 5 minutes", () => {
	assert.equal(MODELS_CACHE_TTL_MS, 5 * 60_000);
});

// --- loadModelCatalogRaw: fresh cache -> no spawn ---------------------------

test("loadModelCatalogRaw: fresh cache is returned without spawning agy", async () => {
	const cachePath = tempCachePath();
	// Seed a fresh cache whose raw differs from what the fake binary prints, so a
	// spawn would be detectable as a changed return value.
	fs.writeFileSync(cachePath, JSON.stringify({ raw: "CACHED", savedAt: Date.now() }));
	const bin = makeFakeAgy("FRESH");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "CACHED"); // served from cache, spawn did not run
});

// --- loadModelCatalogRaw: no cache -> spawn + persist -----------------------

test("loadModelCatalogRaw: no cache spawns agy and persists the result", async () => {
	const cachePath = tempCachePath();
	const bin = makeFakeAgy("Gemini 3.6 Flash (Medium)");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "Gemini 3.6 Flash (Medium)");
	assert.equal(readCacheRaw(cachePath), "Gemini 3.6 Flash (Medium)"); // persisted
});

// --- loadModelCatalogRaw: stale cache -> serve + background refresh ---------

test("loadModelCatalogRaw: stale cache is served instantly, then refreshed in background", async () => {
	const cachePath = tempCachePath();
	// Stale: savedAt well past the TTL.
	const staleSavedAt = Date.now() - MODELS_CACHE_TTL_MS - 60_000;
	fs.writeFileSync(cachePath, JSON.stringify({ raw: "OLD", savedAt: staleSavedAt }));
	const bin = makeFakeAgy("NEW");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "OLD"); // returned the stale cache without waiting

	// The background refresh updates the cache for the next load.
	await waitForCacheRaw(cachePath, "NEW");
});

// --- refreshModelsInBackground: writes the cache on success -----------------

test("refreshModelsInBackground: persists agy output to the cache", async () => {
	const cachePath = tempCachePath();
	const bin = makeFakeAgy("BG-RESULT");
	refreshModelsInBackground(bin, cachePath);
	await waitForCacheRaw(cachePath, "BG-RESULT");
});

// --- corrupt / missing cache -----------------------------------------------

test("loadModelCatalogRaw: corrupt cache is treated as no cache (spawns fresh)", async () => {
	const cachePath = tempCachePath();
	fs.writeFileSync(cachePath, "{not valid json");
	const bin = makeFakeAgy("RECOVERED");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "RECOVERED");
	assert.equal(readCacheRaw(cachePath), "RECOVERED");
});
