// Pins for permission-extension detection + gate-mode resolution
// (docs/TODO.md 2.8, task: config plumbing + detection).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	detectPermissionGateExtensions,
	resolveGateMode,
} from "../src/approval-detect.js";import { loadConfig } from "../src/config.js";

function tmpHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-detect-"));
}

test("detects a known permission package from pi settings (npm: specifier)", () => {
	const home = tmpHome();
	const settings = path.join(home, ".pi", "agent", "settings.json");
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	fs.writeFileSync(
		settings,
		JSON.stringify({ packages: ["npm:@gotgenes/pi-permission-system@31.1.2", "npm:@some/other@1.0.0"] }),
	);
	const hits = detectPermissionGateExtensions({ home, settingsFiles: [settings] });
	assert.equal(hits.length, 1);
	assert.equal(hits[0].name, "@gotgenes/pi-permission-system");
	assert.match(hits[0].evidence, /^settings:/);
	fs.rmSync(home, { recursive: true, force: true });
});

test("detects via on-disk config markers when settings say nothing", () => {
	const home = tmpHome();
	const configDir = path.join(home, ".pi", "agent", "extensions", "pi-permission-system");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), "{}");
	const hits = detectPermissionGateExtensions({ home, settingsFiles: [] });
	assert.deepEqual(
		hits.map((h) => h.name),
		["@gotgenes/pi-permission-system"],
	);
	assert.match(hits[0].evidence, /^config:/);
	fs.rmSync(home, { recursive: true, force: true });
});

test("clean install detects nothing", () => {
	const home = tmpHome();
	const hits = detectPermissionGateExtensions({ home, settingsFiles: [] });
	assert.deepEqual(hits, []);
	fs.rmSync(home, { recursive: true, force: true });
});

test("corrupt settings files are tolerated", () => {
	const home = tmpHome();
	const settings = path.join(home, ".pi", "agent", "settings.json");
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	fs.writeFileSync(settings, "{not json");
	assert.deepEqual(detectPermissionGateExtensions({ home, settingsFiles: [settings] }), []);
	fs.rmSync(home, { recursive: true, force: true });
});

test("name matching respects package-name boundaries (review finding 4)", () => {
	const home = tmpHome();
	const settings = path.join(home, ".pi", "agent", "settings.json");
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	fs.writeFileSync(
		settings,
		JSON.stringify({
			packages: [
				"npm:my-pi-permission-system-clone@1.0.0", // suffix boundary: NOT a hit
				"npm:unrelated@2.0.0",
				"npm:@xzzpig/pi-permission-system@0.6.0", // version suffix: hit
			],
		}),
	);
	const hits = detectPermissionGateExtensions({ home, settingsFiles: [settings] });
	assert.deepEqual(
		hits.map((h) => h.name),
		["@xzzpig/pi-permission-system"],
	);
	fs.rmSync(home, { recursive: true, force: true });
});

test("resolveGateMode matrix", () => {
	const hits = [{ name: "@rhedbull/pi-permissions", evidence: "settings:x" }];
	assert.equal(resolveGateMode("auto", []), "off");
	assert.equal(resolveGateMode("auto", hits), "shadow");
	assert.equal(resolveGateMode("shadow", []), "shadow");
	assert.equal(resolveGateMode("dedicated", []), "dedicated");
	assert.equal(resolveGateMode("off", hits), "off");
});

test("config parses approvals block and env overrides", () => {
	const home = tmpHome();
	const configPath = path.join(home, "config.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({ approvals: { gateMode: "shadow", mode: "allow" } }),
	);
	const fromFile = loadConfig(configPath);
	assert.deepEqual(fromFile.approvals, { gateMode: "shadow", mode: "allow" });

	process.env.AGY_APPROVALS = "off";
	process.env.AGY_APPROVALS_MODE = "deny";
	const fromEnv = loadConfig(configPath);
	assert.deepEqual(fromEnv.approvals, { gateMode: "off", mode: "deny" });
	delete process.env.AGY_APPROVALS;
	delete process.env.AGY_APPROVALS_MODE;

	// garbage falls back to defaults (auto/ask)
	fs.writeFileSync(configPath, JSON.stringify({ approvals: { gateMode: "sometimes", mode: "maybe" } }));
	const fromGarbage = loadConfig(configPath);
	assert.deepEqual(fromGarbage.approvals, { gateMode: "auto", mode: "ask" });

	const defaults = loadConfig(path.join(home, "missing.json"));
	assert.deepEqual(defaults.approvals, { gateMode: "auto", mode: "ask" });
	fs.rmSync(home, { recursive: true, force: true });
});
