// Config tests: engine + bridgeTools knobs round-trip through load/save and
// unrelated saves never clobber them (the merge regression class).

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-")), "config.json");
}

test("config: defaults select the full bridge surface", () => {
	const p = tmpConfig();
	try {
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: bridgeTools round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		for (const surface of ["all", "mcp", "none"] as const) {
			saveConfig({ bridgeTools: surface }, p);
			assert.equal(loadConfig(p).bridgeTools, surface);
		}
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: unrelated save does not clobber bridgeTools", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "none" }, p);
		saveConfig({ mode: "plan" }, p);
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "none");
		assert.equal(c.mode, "plan");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: invalid bridgeTools value falls back to the default surface", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "bogus" as never }, p);
		assert.equal(loadConfig(p).bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: digest defaults off and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).digest, false);
		saveConfig({ digest: true }, p);
		assert.equal(loadConfig(p).digest, true);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).digest, true);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: systemPrompt defaults on and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).systemPrompt, true);
		saveConfig({ systemPrompt: false }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_SYSTEM_PROMPT env overrides the file in both directions", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_SYSTEM_PROMPT;
	try {
		saveConfig({ systemPrompt: true }, p);
		process.env.AGY_SYSTEM_PROMPT = "off";
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ systemPrompt: false }, p);
		process.env.AGY_SYSTEM_PROMPT = "on";
		assert.equal(loadConfig(p).systemPrompt, true);
	} finally {
		if (prev === undefined) delete process.env.AGY_SYSTEM_PROMPT;
		else process.env.AGY_SYSTEM_PROMPT = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});
