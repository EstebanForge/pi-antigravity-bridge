#!/usr/bin/env node
// Live smoke for the stream-json engine. OPT-IN: spends a tiny amount of the
// caller's Antigravity quota. Run: AGY_LIVE=1 node --experimental-strip-types scripts/smoke-stream-json.mjs
// Verifies: driver spawns, init binds a conversation, text deltas arrive,
// result settles, and the process is reused on a second turn (reused: 1).
import { AgyDriver } from "../src/driver.js";
import { parseAgyLine } from "../src/stream-events.js";
import { spawn } from "node:child_process";

if (process.env.AGY_LIVE !== "1") {
	console.error("opt-in only: set AGY_LIVE=1 to spend a tiny amount of quota");
	process.exit(1);
}

// Sanity: agy must be on PATH.
await new Promise((res) => {
	const p = spawn("agy", ["--version"], { stdio: "ignore" });
	p.on("exit", (c) => { if (c !== 0) { console.error("agy not runnable"); process.exit(1); } res(); });
});

const driver = new AgyDriver();
const handle = await driver.run({
	cwd: process.cwd(),
	model: process.env.AGY_SMOKE_MODEL ?? "gemini-3.7-flash-medium",
	mode: "plan",
	skipPermissions: true,
	prompt: "Reply with exactly: SMOKE_OK",
	timeoutMin: 3,
	inactivityMin: 2,
});
let sawText = false;
for (;;) {
	const a = await handle.next();
	if (!a) break;
	if (a.type === "text") sawText = true;
}
const o = await handle.outcome;
console.log("turn1:", JSON.stringify({ status: o.status, conversation: !!o.conversationId, sawText, usage: o.usage ?? null }));
if (o.status !== "OK" || !o.conversationId || !sawText) {
	console.error("smoke FAILED"); await driver.close("shutdown"); process.exit(1);
}
// Second turn: reuse the process, resume the conversation.
const h2 = await driver.run({
	cwd: process.cwd(),
	model: process.env.AGY_SMOKE_MODEL ?? "gemini-3.7-flash-medium",
	mode: "plan",
	skipPermissions: true,
	conversationId: o.conversationId,
	prompt: "Reply with exactly: SMOKE_OK_2",
	timeoutMin: 3,
	inactivityMin: 2,
});
while (await h2.next()) { /* drain */ }
const o2 = await h2.outcome;
const snap = driver.snapshot();
console.log("turn2:", JSON.stringify({ status: o2.status, reused: snap.stats.reused, recycles: snap.stats.recycles }));
await driver.close("shutdown");
const ok = o2.status === "OK" && snap.stats.reused >= 1 && snap.stats.recycles === 0;
console.log(ok ? "smoke PASSED" : "smoke FAILED");
process.exit(ok ? 0 : 1);
