// Pins for per-pid mcp_config.json registration (docs/TODO.md section 1,
// step 2). The file is shared user config: foreign servers must survive,
// corrupt files must be refused, entries must match the exact shape agy
// itself writes (captured live 2026-09-07).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	bridgeServerName,
	mcpConfigPath,
	registerBridgeServer,
	sweepStaleBridgeServers,
	unregisterBridgeServer,
} from "../src/mcp-registration.js";

function tmpHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcpreg-"));
}
function cfgFile(home: string) {
	return path.join(home, ".gemini", "config", "mcp_config.json");
}
const ENTRY = { pid: 4242, port: 47881, token: "secret-token", tokenHeader: "x-bridge-token" };

test("registerBridgeServer writes the exact agy entry shape into a fresh file", () => {
	const home = tmpHome();
	const res = registerBridgeServer(ENTRY, cfgFile(home));
	assert.equal(res.wrote, true);
	const parsed = JSON.parse(fs.readFileSync(cfgFile(home), "utf8"));
	assert.deepEqual(parsed.mcpServers["pi-bridge-4242"], {
		disabled: false,
		headers: { "x-bridge-token": "secret-token" },
		serverUrl: "http://127.0.0.1:47881/mcp",
	});
	fs.rmSync(home, { recursive: true, force: true });
});

test("register preserves foreign servers and refreshes our entry", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({ mcpServers: { "user-server": { serverUrl: "https://example.com/mcp" } } }),
	);
	registerBridgeServer(ENTRY, file);
	registerBridgeServer({ ...ENTRY, port: 50000 }, file);
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(parsed.mcpServers["user-server"], "foreign server preserved");
	assert.equal(parsed.mcpServers["pi-bridge-4242"].serverUrl, "http://127.0.0.1:50000/mcp");
	fs.rmSync(home, { recursive: true, force: true });
});

test("corrupt config is refused, never clobbered", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{broken");
	const res = registerBridgeServer(ENTRY, file);
	assert.equal(res.wrote, false);
	assert.match(res.reason ?? "", /refusing/);
	assert.equal(fs.readFileSync(file, "utf8"), "{broken");
	fs.rmSync(home, { recursive: true, force: true });
});

test("unregister removes only our entry and reports no-op when absent", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	registerBridgeServer(ENTRY, file);
	assert.equal(unregisterBridgeServer(4242, file).wrote, true);
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.mcpServers["pi-bridge-4242"], undefined);
	assert.equal(unregisterBridgeServer(4242, file).wrote, false);
	fs.rmSync(home, { recursive: true, force: true });
});

test("sweep removes dead-pid bridge entries, keeps live ones and foreign ones", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	registerBridgeServer({ ...ENTRY, pid: 1111 }, file);
	registerBridgeServer({ ...ENTRY, pid: 2222 }, file);
	const parsed0 = JSON.parse(fs.readFileSync(file, "utf8"));
	parsed0.mcpServers["user-server"] = { serverUrl: "https://example.com/mcp" };
	parsed0.mcpServers["pi-bridge-notapid"] = { serverUrl: "https://odd.example/mcp" };
	fs.writeFileSync(file, JSON.stringify(parsed0));

	const alive = (pid: number) => pid === 2222;
	const res = sweepStaleBridgeServers(file, alive);
	assert.deepEqual(res.removed.sort(), ["pi-bridge-1111"]);
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.mcpServers["pi-bridge-1111"], undefined);
	assert.ok(parsed.mcpServers["pi-bridge-2222"], "live entry kept");
	assert.ok(parsed.mcpServers["user-server"], "foreign kept");
	assert.ok(parsed.mcpServers["pi-bridge-notapid"], "non-pid name untouched");
	fs.rmSync(home, { recursive: true, force: true });
});

test("bridgeServerName and mcpConfigPath shapes", () => {
	assert.equal(bridgeServerName(7), "pi-bridge-7");
	assert.equal(mcpConfigPath("/h"), path.join("/h", ".gemini", "config", "mcp_config.json"));
});
