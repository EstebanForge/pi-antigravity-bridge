// Engine config: narrowing, defaults, env precedence (plan §9.5). The engine
// key predates 1.3.2 (sqlite era): stale values must fall back to the tested
// default, never poison the config.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cfg-")), "config.json");
}
function rm(p: string): void {
	fs.rmSync(path.dirname(p), { recursive: true, force: true });
}

test("engine defaults to stream-json (ACP is opt-in)", () => {
	const p = tmpConfig();
	try {
		const c = loadConfig(p);
		assert.equal(c.engine, "stream-json");
		assert.equal(c.acp.permissions, "auto");
		assert.equal(c.acp.bin, "");
	} finally {
		rm(p);
	}
});

test("engine switches to acp and round-trips", () => {
	const p = tmpConfig();
	try {
		saveConfig({ engine: "acp" }, p);
		assert.equal(loadConfig(p).engine, "acp");
		// Unrelated saves never clobber the engine choice.
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).engine, "acp");
	} finally {
		rm(p);
	}
});

test("stale/garbage engine values fall back to stream-json", () => {
	const p = tmpConfig();
	try {
		saveConfig({ engine: "acp" }, p);
		const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		raw.engine = "sqlite"; // pre-1.3.2 value
		fs.writeFileSync(p, JSON.stringify(raw));
		assert.equal(loadConfig(p).engine, "stream-json");
		raw.engine = 42;
		fs.writeFileSync(p, JSON.stringify(raw));
		assert.equal(loadConfig(p).engine, "stream-json");
	} finally {
		rm(p);
	}
});

test("AGY_ENGINE env overrides the file", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_ENGINE;
	process.env.AGY_ENGINE = "acp";
	try {
		assert.equal(loadConfig(p).engine, "acp");
		process.env.AGY_ENGINE = "stream-json";
		assert.equal(loadConfig(p).engine, "stream-json");
	} finally {
		if (prev === undefined) delete process.env.AGY_ENGINE;
		else process.env.AGY_ENGINE = prev;
		rm(p);
	}
});

test("AGY_ACP_BIN env overrides acp.bin", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_ACP_BIN;
	process.env.AGY_ACP_BIN = "/opt/agy-acp/server.par";
	try {
		assert.equal(loadConfig(p).acp.bin, "/opt/agy-acp/server.par");
	} finally {
		if (prev === undefined) delete process.env.AGY_ACP_BIN;
		else process.env.AGY_ACP_BIN = prev;
		rm(p);
	}
});

test("acp.bin persists through saveConfig", () => {
	const p = tmpConfig();
	try {
		saveConfig({ acp: { bin: "~/.local/opt/agy-acp/current/agy_acp_server.par", permissions: "auto" } }, p);
		assert.equal(loadConfig(p).acp.bin, "~/.local/opt/agy-acp/current/agy_acp_server.par");
		saveConfig({ digest: true }, p);
		assert.equal(loadConfig(p).acp.bin, "~/.local/opt/agy-acp/current/agy_acp_server.par");
		assert.equal(loadConfig(p).digest, true);
	} finally {
		rm(p);
	}
});
