// Regression tests for the config persistence of invokeToolPatchDeclined.
//
// The silent "do nothing if declined" behavior depends on loadConfig()
// returning the flag. An earlier version wrote the flag to disk but dropped it
// on read-back, making the whole declined path dead code in production (the
// pure decidePatchAction tests still passed because they never touched the
// file). These tests pin the round-trip and the no-clobber guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-")), "config.json");
}

test("config: invokeToolPatchDeclined round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		// Fresh file: undefined (never asked / not declined).
		assert.equal(loadConfig(p).invokeToolPatchDeclined, undefined);
		// Decline persists and is readable back.
		saveConfig({ invokeToolPatchDeclined: true }, p);
		assert.equal(loadConfig(p).invokeToolPatchDeclined, true);
		// Clearing works too.
		saveConfig({ invokeToolPatchDeclined: false }, p);
		assert.equal(loadConfig(p).invokeToolPatchDeclined, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: an unrelated save does not clobber invokeToolPatchDeclined", () => {
	const p = tmpConfig();
	try {
		saveConfig({ invokeToolPatchDeclined: true }, p);
		// A later write for a different key must preserve the declined flag
		// (this is what broke when loadConfig dropped the field: saveConfig's
		// `current` lacked it, so the merge erased it).
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).invokeToolPatchDeclined, true);
		assert.equal(loadConfig(p).mode, "plan");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});
