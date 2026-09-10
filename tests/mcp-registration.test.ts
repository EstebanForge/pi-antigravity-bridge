// Pins for per-pid mcp_config.json registration (docs/TODO.md section 1,
// step 2). The file is shared user config: foreign servers must survive,
// corrupt files must be refused, entries must match the exact shape agy
// itself writes (captured live 2026-09-07).
//
// Also pins the cross-process suppression marker (suppression.json): the
// delegator registry that lets two pi sessions delegate concurrently without
// re-enabling each other's entries, and the marker-aware session-start heal.
//
// Every write path gets an injected markerPath so the suite never touches the
// real user marker and stays deterministic while delegations run elsewhere.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	acquireBridgeSuppression,
	bridgeServerName,
	healBridgeSuppression,
	mcpConfigPath,
	registerBridgeServer,
	setBridgeEntriesDisabled,
	suppressionMarkerPath,
	sweepStaleBridgeServers,
	unregisterBridgeServer,
} from "../src/mcp-registration.js";

function tmpHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcpreg-"));
}
function cfgFile(home: string) {
	return path.join(home, ".gemini", "config", "mcp_config.json");
}
function markerFile(home: string) {
	return path.join(home, "suppression.json");
}
const ENTRY = { pid: 4242, port: 47881, token: "secret-token", tokenHeader: "x-bridge-token" };

/** Registration with a hermetic marker so results never depend on the real
 *  machine's delegation state. */
function reg(home: string, entry: typeof ENTRY) {
	return registerBridgeServer(entry, cfgFile(home), { markerPath: markerFile(home) });
}

test("registerBridgeServer writes the exact agy entry shape into a fresh file", () => {
	const home = tmpHome();
	const res = reg(home, ENTRY);
	assert.equal(res.wrote, true);
	assert.equal(res.disabled, false);
	const parsed = JSON.parse(fs.readFileSync(cfgFile(home), "utf8"));
	assert.deepEqual(parsed.mcpServers["pi-bridge-4242"], {
		disabled: false,
		headers: { "x-bridge-token": "secret-token" },
		serverUrl: "http://127.0.0.1:47881/mcp",
	});
	fs.rmSync(home, { recursive: true, force: true });
});

test("the shared config file lands 0600 (it carries the bridge token)", () => {
	const home = tmpHome();
	reg(home, ENTRY);
	const mode = fs.statSync(cfgFile(home)).mode & 0o777;
	assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
	// And a pre-existing world-readable file is tightened on the next write.
	const file = cfgFile(home);
	fs.chmodSync(file, 0o644);
	unregisterBridgeServer(4242, file);
	const after = fs.statSync(file).mode & 0o777;
	assert.equal(after, 0o600, `expected 0600 after rewrite, got ${after.toString(8)}`);
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
	reg(home, ENTRY);
	reg(home, { ...ENTRY, port: 50000 });
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
	const res = reg(home, ENTRY);
	assert.equal(res.wrote, false);
	assert.match(res.reason ?? "", /refusing/);
	assert.equal(fs.readFileSync(file, "utf8"), "{broken");
	fs.rmSync(home, { recursive: true, force: true });
});

test("unregister removes only our entry and reports no-op when absent", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	reg(home, ENTRY);
	assert.equal(unregisterBridgeServer(4242, file).wrote, true);
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.mcpServers["pi-bridge-4242"], undefined);
	assert.equal(unregisterBridgeServer(4242, file).wrote, false);
	fs.rmSync(home, { recursive: true, force: true });
});

test("sweep removes dead-pid bridge entries, keeps live ones and foreign ones", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	reg(home, { ...ENTRY, pid: 1111 });
	reg(home, { ...ENTRY, pid: 2222 });
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

test("bridgeServerName, mcpConfigPath and suppressionMarkerPath shapes", () => {
	assert.equal(bridgeServerName(7), "pi-bridge-7");
	assert.equal(mcpConfigPath("/h"), path.join("/h", ".gemini", "config", "mcp_config.json"));
	assert.equal(
		suppressionMarkerPath("/h"),
		path.join(
			"/h",
			".pi",
			"extensions-data",
			"estebanforge",
			"pi-antigravity-bridge",
			"suppression.json",
		),
	);
});

test("setBridgeEntriesDisabled flips only our entries and restores them", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	reg(home, { ...ENTRY, pid: 1111 });
	reg(home, { ...ENTRY, pid: 2222 });
	const seed = JSON.parse(fs.readFileSync(file, "utf8"));
	seed.mcpServers["user-server"] = { serverUrl: "https://example.com/mcp" };
	fs.writeFileSync(file, JSON.stringify(seed));

	const off = setBridgeEntriesDisabled(true, file);
	assert.equal(off.wrote, true);
	assert.equal(off.changed, 2);
	let parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.mcpServers["pi-bridge-1111"].disabled, true);
	assert.equal(parsed.mcpServers["pi-bridge-2222"].disabled, true);
	assert.equal(parsed.mcpServers["user-server"].disabled, undefined, "foreign untouched");
	assert.ok(parsed.mcpServers["user-server"], "foreign preserved");

	// Idempotent: no change means no write.
	const again = setBridgeEntriesDisabled(true, file);
	assert.equal(again.wrote, false);
	assert.equal(again.changed, 0);

	const on = setBridgeEntriesDisabled(false, file);
	assert.equal(on.wrote, true);
	assert.equal(on.changed, 2);
	parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.mcpServers["pi-bridge-1111"].disabled, false);
	assert.equal(parsed.mcpServers["pi-bridge-2222"].disabled, false);
	assert.ok(parsed.mcpServers["user-server"], "foreign still preserved");
	fs.rmSync(home, { recursive: true, force: true });
});

test("acquireBridgeSuppression refcounts: first acquire disables, last release restores", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);

	const releaseA = acquireBridgeSuppression({ configPath: file, markerPath: marker });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled, true);

	// Overlapping acquire: no extra write needed, and an early release must
	// NOT restore while another holder is still active (the clobber race).
	const releaseB = acquireBridgeSuppression({ configPath: file, markerPath: marker });
	releaseA();
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled, true);

	releaseB();
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled, false);

	// Double release is a no-op.
	releaseA();
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled, false);
	fs.rmSync(home, { recursive: true, force: true });
});

test("setBridgeEntriesDisabled refuses corrupt config, no-ops on missing/empty", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{broken");
	const refused = setBridgeEntriesDisabled(true, file);
	assert.equal(refused.wrote, false);
	assert.match(refused.reason ?? "", /refusing/);
	assert.equal(fs.readFileSync(file, "utf8"), "{broken");

	// Missing file: nothing to flip, nothing to write.
	const missing = setBridgeEntriesDisabled(false, cfgFile(tmpHome()));
	assert.equal(missing.wrote, false);
	assert.equal(missing.changed, 0);
	fs.rmSync(home, { recursive: true, force: true });
});

// --- Cross-process suppression marker ---------------------------------------

test("acquire records the delegator in the marker; release removes it", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);

	const release = acquireBridgeSuppression({ configPath: file, markerPath: marker, pid: 1111 });
	const m = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.ok(m.delegators["1111"].since > 0, "delegator recorded with a timestamp");

	release();
	const after = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.equal(after.delegators["1111"], undefined, "delegator removed on release");
	assert.equal(
		JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled,
		false,
	);
	fs.rmSync(home, { recursive: true, force: true });
});

test("the marker file lands 0600 inside a 0700 directory", () => {
	const home = tmpHome();
	const marker = markerFile(home);
	const release = acquireBridgeSuppression({
		configPath: cfgFile(home),
		markerPath: marker,
		pid: 1111,
	});
	const mode = fs.statSync(marker).mode & 0o777;
	assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
	const dirMode = fs.statSync(path.dirname(marker)).mode & 0o777;
	assert.equal(dirMode, 0o700, `expected 0700 on the data dir, got ${dirMode.toString(8)}`);
	release();
	fs.rmSync(home, { recursive: true, force: true });
});

test("two sessions delegating concurrently: entries stay disabled until the LAST release", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, { ...ENTRY, pid: 1111 });
	reg(home, { ...ENTRY, pid: 2222 });
	const alive = (pid: number) => pid === 1111 || pid === 2222;
	const opts = { configPath: file, markerPath: marker, isAlive: alive };

	const releaseA = acquireBridgeSuppression({ ...opts, pid: 1111 });
	const releaseB = acquireBridgeSuppression({ ...opts, pid: 2222 });

	// Session A finishes first: B is still delegating, entries must stay hidden.
	releaseA();
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-1111"].disabled, true);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-2222"].disabled, true);
	let m = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.deepEqual(Object.keys(m.delegators).sort(), ["2222"], "A pruned, B kept");

	// Session B finishes: no live delegator remains, entries come back.
	releaseB();
	m = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.deepEqual(m.delegators, {});
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-1111"].disabled, false);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-2222"].disabled, false);
	fs.rmSync(home, { recursive: true, force: true });
});

test("release prunes a dead co-delegator and restores entries", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);
	// A crashed pi left pid 999 behind (dead now).
	fs.writeFileSync(
		marker,
		JSON.stringify({ delegators: { "999": { since: Date.now() } } }),
	);

	const alive = (pid: number) => pid === process.pid;
	const release = acquireBridgeSuppression({ configPath: file, markerPath: marker, isAlive: alive });
	release();
	const m = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.deepEqual(m.delegators, {}, "dead co-delegator pruned");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled, false);
	fs.rmSync(home, { recursive: true, force: true });
});

test("session-start heal keeps entries hidden while a live delegation is in flight", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);
	setBridgeEntriesDisabled(true, file);
	fs.writeFileSync(
		marker,
		JSON.stringify({ delegators: { "1111": { since: Date.now() } } }),
	);

	const res = healBridgeSuppression({
		configPath: file,
		markerPath: marker,
		isAlive: (pid) => pid === 1111,
	});
	assert.equal(res.reEnabled, false);
	assert.deepEqual(res.pruned, []);
	assert.equal(
		JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled,
		true,
		"the in-flight delegation keeps its suppression",
	);
	fs.rmSync(home, { recursive: true, force: true });
});

test("heal prunes dead delegators and re-enables the entries", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);
	setBridgeEntriesDisabled(true, file);
	fs.writeFileSync(
		marker,
		JSON.stringify({ delegators: { "999": { since: Date.now() } } }),
	);

	const res = healBridgeSuppression({ configPath: file, markerPath: marker, isAlive: () => false });
	assert.equal(res.reEnabled, true);
	assert.deepEqual(res.pruned, ["999"]);
	assert.equal(
		JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled,
		false,
	);
	fs.rmSync(home, { recursive: true, force: true });
});

test("heal prunes a delegator past the age bound even when its pid looks alive", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);
	setBridgeEntriesDisabled(true, file);
	const stale = Date.now() - 25 * 60 * 60 * 1000;
	fs.writeFileSync(marker, JSON.stringify({ delegators: { "1111": { since: stale } } }));

	const res = healBridgeSuppression({
		configPath: file,
		markerPath: marker,
		isAlive: () => true, // pid reuse or anything else: age wins
	});
	assert.equal(res.reEnabled, true);
	assert.deepEqual(res.pruned, ["1111"]);
	fs.rmSync(home, { recursive: true, force: true });
});

test("corrupt marker is treated as empty: heal re-enables, no crash", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	reg(home, ENTRY);
	setBridgeEntriesDisabled(true, file);
	fs.writeFileSync(marker, "{broken");

	const res = healBridgeSuppression({ configPath: file, markerPath: marker, isAlive: () => true });
	assert.equal(res.reEnabled, true);
	assert.equal(
		JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled,
		false,
	);
	fs.rmSync(home, { recursive: true, force: true });
});

test("registerBridgeServer lands disabled while a live delegation is in flight", () => {
	const home = tmpHome();
	const file = cfgFile(home);
	const marker = markerFile(home);
	fs.writeFileSync(
		marker,
		JSON.stringify({ delegators: { "1111": { since: Date.now() } } }),
	);

	const suppressed = registerBridgeServer(ENTRY, file, {
		markerPath: marker,
		isAlive: (pid) => pid === 1111,
	});
	assert.equal(suppressed.disabled, true);
	assert.equal(
		JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["pi-bridge-4242"].disabled,
		true,
		"a fresh session must not open a door for the delegated agy mid-run",
	);

	// No live delegation: registration is normally enabled.
	const normal = registerBridgeServer({ ...ENTRY, port: 47882 }, file, {
		markerPath: marker,
		isAlive: () => false,
	});
	assert.equal(normal.disabled, false);
	fs.rmSync(home, { recursive: true, force: true });
});
