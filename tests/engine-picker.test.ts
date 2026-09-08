// Engine picker tests: the first-run predicate and the picker copy/order.
// The overlay itself is TUI-bound; its logic lives in the two exports below.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ENGINE_PICKER_ITEMS,
	ENGINE_PICKER_INTRO,
	savedEngineMessage,
	shouldOfferEnginePicker,
	toEngine,
} from "../src/engine-picker.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-picker-")), "config.json");
}

test("picker: first run (no config file, no env) offers the picker", () => {
	const p = tmpConfig();
	try {
		assert.equal(shouldOfferEnginePicker(p, {}), true);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: existing config file suppresses the picker", () => {
	const p = tmpConfig();
	try {
		fs.writeFileSync(p, "{}\n");
		assert.equal(shouldOfferEnginePicker(p, {}), false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: AGY_ENGINE env suppresses the picker even on a fresh install", () => {
	const p = tmpConfig();
	try {
		assert.equal(shouldOfferEnginePicker(p, { AGY_ENGINE: "acp" }), false);
		assert.equal(shouldOfferEnginePicker(p, { AGY_ENGINE: "" }), false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("picker: stream-json is the first (default preselected) option", () => {
	assert.equal(ENGINE_PICKER_ITEMS.length, 2);
	assert.equal(ENGINE_PICKER_ITEMS[0]?.value, "stream-json");
	assert.equal(ENGINE_PICKER_ITEMS[1]?.value, "acp");
});

test("picker: only the literal acp value selects the ACP engine", () => {
	assert.equal(toEngine("acp"), "acp");
	assert.equal(toEngine("stream-json"), "stream-json");
	assert.equal(toEngine("acp "), "stream-json");
	assert.equal(toEngine("sqlite"), "stream-json");
});

test("picker: saved-engine toast names the restart and ACP setup steps", () => {
	assert.match(savedEngineMessage("stream-json"), /Restart pi to apply/);
	const acp = savedEngineMessage("acp");
	assert.match(acp, /\/agy auth/);
	assert.match(acp, /AGY_ACP_BIN/);
	// Sets the expectation before the restart triggers a long download.
	assert.match(acp, /downloads automatically/);
	assert.match(acp, /~1\.5 GB/);
});

test("picker: intro explains both engines' constraints", () => {
	assert.match(ENGINE_PICKER_INTRO, /agy` CLI/);
	assert.match(ENGINE_PICKER_INTRO, /authenticated/);
	assert.match(ENGINE_PICKER_INTRO, /official server/);
	assert.match(ENGINE_PICKER_INTRO, /second Google sign-in/);
	// The download is the ACP engine's main cost; the pin keeps it disclosed.
	assert.match(ENGINE_PICKER_INTRO, /~1\.5 GB/);
	assert.match(ENGINE_PICKER_INTRO, /unavoidable/);
	assert.match(ENGINE_PICKER_INTRO, /\/agy engine/);
});
