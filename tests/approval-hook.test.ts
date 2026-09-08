// Pins for hooks.json staging (docs/TODO.md 2.8, staging task).
// Merge-safety is the point: foreign hook groups survive, foreign files get
// backed up before first modification, unparseable files are never touched.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import { symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	GATE_GROUP_PREFIX,
	buildGateGroup,
	gateGroupKey,
	hookScriptSource,
	removeGateHooks,
	stagedTimeoutSeconds,
	stageGateHooks,
} from "../src/approval-hook.js";

function tmpWs() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-stage-"));
}
const opts = {
	port: 47881,
	token: "secret-token",
	scriptPath: "/data/dir/approval-hook.mjs",
	parkBudgetMs: 480_000,
};

test("stages into a fresh workspace: group shape, matcher, generous timeout", () => {
	const ws = tmpWs();
	const res = stageGateHooks(ws, opts);
	assert.equal(res.wrote, true);
	const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".agents", "hooks.json"), "utf8"));
	const group = parsed[gateGroupKey()];
	assert.equal(group.enabled, true);
	const handler = group.PreToolUse[0].hooks[0];
	assert.match(group.PreToolUse[0].matcher, /create_file/);
	assert.match(group.PreToolUse[0].matcher, /run_command/);
	assert.equal(handler.command, 'node "/data/dir/approval-hook.mjs"');
	// V3: timeout must exceed the park budget (soft-pass on timeout)
	assert.ok(handler.timeout >= opts.parkBudgetMs / 1000);
	fs.rmSync(ws, { recursive: true, force: true });
});

test("idempotent restage: no write, no backup", () => {
	const ws = tmpWs();
	stageGateHooks(ws, opts);
	const res = stageGateHooks(ws, opts);
	assert.equal(res.wrote, false);
	assert.equal(res.reason, "already staged");
	assert.equal(res.backup, undefined);
	fs.rmSync(ws, { recursive: true, force: true });
});

test("foreign groups preserved; backup written before first modification", () => {
	const ws = tmpWs();
	const dir = path.join(ws, ".agents");
	fs.mkdirSync(dir, { recursive: true });
	const foreignFile = path.join(dir, "hooks.json");
	fs.writeFileSync(foreignFile, JSON.stringify({ "user-linter": { PostToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "lint", timeout: 5 }] }] } }));
	const res = stageGateHooks(ws, opts);
	assert.equal(res.wrote, true);
	assert.ok(res.backup, "backup expected for foreign file");
	assert.ok(fs.existsSync(res.backup ?? ""), "backup exists");
	const merged = JSON.parse(fs.readFileSync(foreignFile, "utf8"));
	assert.ok(merged["user-linter"], "foreign group survived");
	assert.ok(merged[gateGroupKey()], "gate group added");
	// backup holds the pre-merge content
	const backupContent = JSON.parse(fs.readFileSync(res.backup ?? "", "utf8"));
	assert.equal(backupContent[gateGroupKey()], undefined);
	fs.rmSync(ws, { recursive: true, force: true });
});

test("unparseable hooks.json is never touched", () => {
	const ws = tmpWs();
	const file = path.join(ws, ".agents", "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{broken");
	const res = stageGateHooks(ws, opts);
	assert.equal(res.wrote, false);
	assert.match(res.reason ?? "", /refusing/);
	assert.equal(fs.readFileSync(file, "utf8"), "{broken");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("symlinked hooks.json is refused, not followed", () => {
	const ws = tmpWs();
	const target = path.join(ws, "real-hooks.json");
	fs.writeFileSync(target, JSON.stringify({ "user-linter": { PostToolUse: [] } }));
	const dir = path.join(ws, ".agents");
	fs.mkdirSync(dir, { recursive: true });
	const link = path.join(dir, "hooks.json");
	symlinkSync(target, link);
	const res = stageGateHooks(ws, opts);
	assert.equal(res.wrote, false);
	assert.match(res.reason ?? "", /symlink/);
	// target untouched
	const targetNow = JSON.parse(fs.readFileSync(target, "utf8"));
	assert.equal(targetNow[gateGroupKey()], undefined);
	assert.equal(removeGateHooks(ws).reason, "hooks.json is a symlink; refusing to follow it");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("removeGateHooks strips only our group and reports absent/foreign safely", () => {
	const ws = tmpWs();
	assert.equal(removeGateHooks(ws).reason, "no hooks.json");
	stageGateHooks(ws, opts);
	const res = removeGateHooks(ws);
	assert.equal(res.wrote, true);
	const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".agents", "hooks.json"), "utf8"));
	assert.equal(parsed[gateGroupKey()], undefined);
	assert.equal(removeGateHooks(ws).reason, "not staged");
	fs.rmSync(ws, { recursive: true, force: true });
});

// --- per-pid ownership (audit 2026-09-07: concurrent sessions share the
// workspace, so one session must never strip another's gate) -------------------

const foreignOpts = { ...opts, scriptPath: "/data/dir/approval-hook-1.js" };
const deadOpts = { ...opts, scriptPath: "/data/dir/approval-hook-4194000.js" };

function seedGroup(ws: string, key: string, groupOpts: typeof opts): void {
	const file = path.join(ws, ".agents", "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	current[key] = buildGateGroup(groupOpts);
	fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
}

function readKeys(ws: string): string[] {
	return Object.keys(JSON.parse(fs.readFileSync(path.join(ws, ".agents", "hooks.json"), "utf8")));
}

test("a live session's gate group is never touched by another session's staging", () => {
	const ws = tmpWs();
	// pid 1 is alive (init/systemd); its group must survive our staging.
	seedGroup(ws, gateGroupKey(1), foreignOpts);
	stageGateHooks(ws, opts);
	const keys = readKeys(ws);
	assert.ok(keys.includes(gateGroupKey(1)), "live foreign group preserved");
	assert.ok(keys.includes(gateGroupKey()), "own group staged alongside");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("a dead session's gate group is swept by the next staging", () => {
	const ws = tmpWs();
	seedGroup(ws, gateGroupKey(4194000), deadOpts);
	stageGateHooks(ws, opts);
	const keys = readKeys(ws);
	assert.equal(keys.includes(gateGroupKey(4194000)), false, "dead group swept");
	assert.ok(keys.includes(gateGroupKey()), "own group staged");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("the legacy shared key is swept when its session is dead, kept when live", () => {
	const ws = tmpWs();
	seedGroup(ws, GATE_GROUP_PREFIX, deadOpts); // legacy key, dead pid -> sweep
	seedGroup(ws, `${GATE_GROUP_PREFIX}-999998`, foreignOpts); // live pid -> keep
	stageGateHooks(ws, opts);
	const keys = readKeys(ws);
	assert.equal(keys.includes(GATE_GROUP_PREFIX), false, "legacy key with dead session swept");
	assert.ok(keys.includes(`${GATE_GROUP_PREFIX}-999998`), "live session's group kept");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("an unattributable gate group is left alone (foreign format)", () => {
	const ws = tmpWs();
	const file = path.join(ws, ".agents", "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ "pi-bridge-gate-weird": { enabled: true } }));
	stageGateHooks(ws, opts);
	assert.ok(readKeys(ws).includes("pi-bridge-gate-weird"), "unattributable group preserved");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("removeGateHooks with an explicit pid removes only that pid's group", () => {
	const ws = tmpWs();
	seedGroup(ws, gateGroupKey(1), foreignOpts);
	stageGateHooks(ws, opts);
	// Session 1 (alive) shuts down: its own removal must not touch ours.
	const res = removeGateHooks(ws, 1);
	assert.equal(res.wrote, true);
	const keys = readKeys(ws);
	assert.equal(keys.includes(gateGroupKey(1)), false);
	assert.ok(keys.includes(gateGroupKey()), "our group survived session 1's removal");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("hook script source: posts, polls, fails closed on deadline", () => {
	const src = hookScriptSource({ port: 47881, token: "secret-token", deadlineMs: 540_000 });
	assert.match(src, /\/approval/);
	assert.match(src, /x-bridge-token/);
	assert.equal(src.includes("secret-token"), true);
	assert.match(src, /decision: "deny", reason: "approval gate deadline exceeded"/);
	assert.match(src, /decision: "deny", reason: "approval gate unreachable/);
});

test("stagedTimeoutSeconds floors at 60s and adds margin", () => {
	assert.equal(stagedTimeoutSeconds(480_000), 540);
	assert.equal(stagedTimeoutSeconds(0), 60, "floor at 60s");
	assert.equal(stagedTimeoutSeconds(1_000), 61, "margin dominates above the floor");
});

test("buildGateGroup carries port/token only through the script path", () => {
	const group = buildGateGroup(opts);
	const handler = (group as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse[0].hooks[0];
	assert.equal(handler.command, 'node "/data/dir/approval-hook.mjs"');
	assert.equal(handler.command.includes("secret-token"), false, "token stays in the script file, not hooks.json");
});
