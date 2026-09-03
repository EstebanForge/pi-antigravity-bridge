// Live parity run: the SAME scenario set through BOTH engines (plan §6).
// Gated: AGY_ACP_LIVE=1 (spends quota: ~13 flash-low turns).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/parity-live.mjs
//
// Requires the `agy` CLI on PATH for the stream-json engine. Prints a
// per-scenario matrix and exits non-zero on any mismatch with the parity
// contract (docs/ACP-ADOPTION-PLAN.md §6).

import { execFileSync } from "node:child_process";
import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary } from "../src/acp/connection.js";
import { AgyDriver } from "../src/driver.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}
try {
	execFileSync("agy", ["--version"], { stdio: "ignore" });
} catch {
	console.error("refusing to run: `agy` CLI not on PATH (stream-json engine)");
	process.exit(1);
}

const MODEL = "gemini-3.7-flash";
const BASE = {
	cwd: process.cwd(),
	model: MODEL,
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	timeoutMin: 2,
};
const ECHO_TOKEN = "PARITY-ECHO";

// --- bridge echo server (shared by both engines) ----------------------------
const bridgeCalls = [];
const bridge = await startMcpServer({
	listTools: () => [
		{
			name: "bridge_echo",
			description: "Echoes the given text back, prefixed with ECHO:. Use this tool when asked to.",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		},
	],
	onToolCall: async (_callId, name, args) => {
		bridgeCalls.push(name);
		return {
			content: [{ type: "text", text: `ECHO:${typeof args.text === "string" ? args.text : ""}` }],
			isError: false,
		};
	},
});
if (!bridge.ok || !bridge.handle) {
	console.error(`bridge failed to start: ${bridge.reason}`);
	process.exit(1);
}
const mcpServers = () => [
	{
		name: "pi-bridge",
		type: "http",
		url: `http://127.0.0.1:${bridge.handle.port}/mcp`,
		headers: [{ name: TOKEN_HEADER, value: bridge.handle.token }],
	},
];

// --- turn runner (shared surface) -------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(driver, request) {
	const controller = new AbortController();
	const deltas = [];
	const tools = [];
	let aborted = false;
	const handle = await driver.run({ ...BASE, ...request, signal: controller.signal });
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			if (activity.type === "text") deltas.push(activity.delta);
			else if (activity.type === "tool_start" || activity.type === "tool_done") tools.push(activity.name);
			if (activity.type === "text" && request.abortAfterFirstDelta && deltas.length === 1) {
				aborted = true;
				controller.abort();
			}
		}
	})();
	const outcome = await handle.outcome;
	await collecting;
	return { outcome, deltas, tools, abortedByScript: aborted };
}

const nonCumulative = (deltas) => {
	let acc = deltas[0];
	for (const d of deltas.slice(1)) {
		if (d.startsWith(acc) && d.length > acc.length) return false; // full re-send
		acc += d;
	}
	return true;
};

/** Status + error context for the pass/fail line; empty when healthy. */
function errCtx(t) {
	if (t.outcome.status === "OK") return "";
	return ` status=${t.outcome.status} err=${t.outcome.error ?? "(none)"}`;
}

// --- scenarios ---------------------------------------------------------------
async function parity(driver, tag) {
	const results = {};
	const ok = (name, pass, detail) => {
		results[name] = { pass, detail };
		console.log(`  [${tag}] ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
	};

	// 1. streaming text: deltas arrive, no cumulative re-sends
	const t1 = await runTurn(driver, { prompt: `Reply with exactly: PARITY-${tag}-1. No tools.` });
	const j1 = t1.deltas.join("");
	ok(
		"text-stream",
		t1.outcome.status === "OK" && j1.includes(`PARITY-${tag}-1`) && nonCumulative(t1.deltas),
		`deltas=${t1.deltas.length} text=${JSON.stringify(j1.slice(0, 80))}${errCtx(t1)}`,
	);
	await sleep(3000);

	// 2. multi-turn continuity: thread conversationId like the provider's
	// session store does (legacy: --conversation resume; ACP: session/load).
	const t2 = await runTurn(driver, {
		prompt: "What exact phrase did I just ask you to reply with? Reply with only that phrase, nothing else.",
		conversationId: t1.outcome.conversationId,
	});
	ok(
		"continuity",
		t2.outcome.status === "OK" && t2.deltas.join("").includes(`PARITY-${tag}-1`),
		`text=${JSON.stringify(t2.deltas.join("").slice(0, 80))}${errCtx(t2)}`,
	);
	await sleep(3000);

	// 3. bridge tool round-trip (continuation of the same conversation)
	const t3 = await runTurn(driver, {
		prompt: `Call the bridge_echo tool with text exactly ${ECHO_TOKEN}, then reply with the exact text the tool returned and nothing else. Do not explore, do not run commands, do not read files: use only bridge_echo.`,
		conversationId: t2.outcome.conversationId,
	});
	ok(
		"bridge-roundtrip",
		t3.outcome.status === "OK" &&
			// legacy surfaces MCP calls under agy's wrapper name (call_mcp_tool);
			// ACP surfaces the bridge tool's own name.
			(t3.tools.includes("bridge_echo") || t3.tools.includes("call_mcp_tool")) &&
			t3.deltas.join("").includes(`ECHO:${ECHO_TOKEN}`),
		`tools=[${t3.tools}] text=${JSON.stringify(t3.deltas.join("").slice(0, 80))}${errCtx(t3)}`,
	);
	await sleep(3000);

	// 4. effort switch mid-conversation (Gate A: set_config_option / legacy recycle+resume)
	const t4 = await runTurn(driver, {
		prompt: "Reply with exactly: PARITY-SWITCH. No tools.",
		effort: "high",
		conversationId: t3.outcome.conversationId,
	});
	ok("effort-switch", t4.outcome.status === "OK" && t4.deltas.join("").includes("PARITY-SWITCH"), errCtx(t4));
	await sleep(3000);

	// 5. serialization: two concurrent runs must both complete, never interleave
	const [a, b] = await Promise.all([
		runTurn(driver, { prompt: "Reply with exactly: PARITY-SER-A. No tools." }),
		runTurn(driver, { prompt: "Reply with exactly: PARITY-SER-B. No tools." }),
	]);
	const ja = a.deltas.join("");
	const jb = b.deltas.join("");
	ok(
		"serialization",
		a.outcome.status === "OK" &&
			b.outcome.status === "OK" &&
			ja.includes("PARITY-SER-A") &&
			jb.includes("PARITY-SER-B"),
		`a=${JSON.stringify(ja.slice(0, 40))}${errCtx(a)} b=${JSON.stringify(jb.slice(0, 40))}${errCtx(b)}`,
	);

	// 6. abort mid-turn, then the driver still serves the next turn
	const t6 = await runTurn(driver, {
		prompt: "Count from 1 to 300, one number per line.",
		abortAfterFirstDelta: true,
	});
	const t6b = await runTurn(driver, { prompt: "Reply with exactly: PARITY-AFTER-ABORT. No tools." });
	ok(
		"abort-recover",
		t6.outcome.aborted === true &&
			t6b.outcome.status === "OK" &&
			t6b.deltas.join("").includes("PARITY-AFTER-ABORT"),
		`abort=${t6.outcome.aborted}${errCtx(t6)} recover=${errCtx(t6b)}`,
	);

	ok(
		"usage-fields",
		tag === "legacy" ? t1.outcome.usage != null : t1.outcome.usage == null,
		tag === "legacy" ? "mapped" : "documented-absent (Gate B)",
	);

	return results;
}

// --- run both engines --------------------------------------------------------
const matrix = {};
{
	console.log("[parity] engine: stream-json (agy CLI)");
	const driver = new AgyDriver();
	try {
		matrix["stream-json"] = await parity(driver, "legacy");
	} finally {
		await driver.close("shutdown");
	}
}
{
	console.log("[parity] engine: acp (official server)");
	const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");
	console.log(`[parity] bin: ${bin}`);
	const driver = new AcpDriver({
		bin,
		mcpServers,
		log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
	});
	try {
		matrix["acp"] = await parity(driver, "acp");
	} finally {
		await driver.close("shutdown");
	}
}

await bridge.handle.close();

console.log(`\nbridge tool calls seen: ${bridgeCalls.length}`);
console.log("\n=== PARITY MATRIX ===");
const names = Object.keys(matrix["stream-json"]);
let allPass = true;
for (const name of names) {
	const l = matrix["stream-json"][name];
	const a = matrix["acp"][name];
	const pass = l?.pass && a?.pass;
	allPass = allPass && pass;
	console.log(`${pass ? "x" : " "} ${name.padEnd(18)} stream-json=${l?.pass ? "PASS" : "FAIL"}  acp=${a?.pass ? "PASS" : "FAIL"}`);
	if (!pass) {
		if (!l?.pass) console.log(`    stream-json detail: ${l?.detail ?? "(no detail)"}`);
		if (!a?.pass) console.log(`    acp detail: ${a?.detail ?? "(no detail)"}`);
	}
}
console.log(allPass ? "\nPARITY OK." : "\nPARITY FAILED.");
process.exit(allPass ? 0 : 1);
