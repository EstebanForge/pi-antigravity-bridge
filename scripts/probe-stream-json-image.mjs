// Live probe: does the stream-json CLI deliver MCP tool-result IMAGE content
// to the model? Gated: AGY_LIVE=1 (spends quota).
//
//   AGY_LIVE=1 npx tsx scripts/probe-stream-json-image.mjs
//
// Same question the ACP probe (probe-acp-image-result.mjs) answered for the
// ACP engine, now for the legacy engine: the community "broken image upload"
// reports were about the CLI's own image upload, never about MCP tool
// results through its client. The bridge serves one tool whose result
// carries a two-tone PNG (left green, right yellow); the model must name
// both halves from the TOOL RESULT alone.
//
// Wiring mirrors production: startMcpServer writes .agents/mcp_config.json
// for this pid, and the driver's spawn adds the dir via --add-dir when the
// file exists.
//
// SAFETY: the temp workspace is the ONLY directory this script may ever
// delete, and only when it created that dir itself. An AGY_PROBE_CWD
// override (trusted-workspace registration checks) is NEVER deleted.

import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AgyDriver } from "../src/driver.js";
import { bridgeMcpConfigDir, startMcpServer } from "../src/mcp-server.js";
import zlib from "node:zlib";

if (process.env.AGY_LIVE !== "1") {
	console.error("refusing to run: set AGY_LIVE=1 (spends quota)");
	process.exit(1);
}

// --- raw frame log ------------------------------------------------------------
const RAW = "probe-logs/stream-json-image-traffic.log";
mkdirSync("probe-logs", { recursive: true });
const log = (obj) => appendFileSync(RAW, JSON.stringify(obj) + "\n");

// --- two-tone PNG: left GREEN, right YELLOW (color on X, not Y) ----------------
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function twoTonePng() {
	const w = 64;
	const h = 64;
	const stride = 1 + w * 3;
	const buf = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const row = y * stride;
		buf[row] = 0;
		for (let x = 0; x < w; x++) {
			const o = row + 1 + x * 3;
			if (x < w / 2) {
				buf[o] = 0;
				buf[o + 1] = 255;
				buf[o + 2] = 0;
			} else {
				buf[o] = 255;
				buf[o + 1] = 255;
				buf[o + 2] = 0;
			}
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(buf)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const PNG_B64 = twoTonePng().toString("base64");
console.log(`[probe] png: ${PNG_B64.length} b64 chars`);

const PROMPT =
	"You must call the bridge_image_probe tool (an MCP tool from the pi-bridge server) exactly once to load the image; no other tool can show it. Then reply with ONLY the LEFT half color and RIGHT half color of the image it returned, like: LEFT=<color> RIGHT=<color>";

// Anti-cheat: run OUTSIDE the repo so the model cannot grep the PNG's colors
// out of this script's source (it did exactly that on the first run).
const probeCwdOverride = process.env.AGY_PROBE_CWD
	? path.resolve(process.env.AGY_PROBE_CWD)
	: undefined;
const WorkCwd = probeCwdOverride ?? mkdtempSync(path.join(os.tmpdir(), "agy-stream-image-probe-"));

// --- bridge MCP server: result carries the image -------------------------------
let toolCalls = 0;
const bridge = await startMcpServer({
	log: (msg, data) => log({ t: "bridge", msg, data }),
	listTools: () => [
		{
			name: "bridge_image_probe",
			description:
				"Returns an image file's content. Use this tool when asked to load or show an image.",
			inputSchema: { type: "object", properties: {}, required: [] },
		},
	],
	onToolCall: async (_callId, name) => {
		toolCalls += 1;
		log({ t: "tool-called", name });
		return {
			content: [
				{ type: "image", data: PNG_B64, mimeType: "image/png" },
				{ type: "text", text: "Image loaded (64x64 PNG, two vertical halves, each solid)." },
			],
			isError: false,
		};
	},
});
if (!bridge.ok || !bridge.handle) {
	console.error(`bridge failed to start: ${bridge.reason}`);
	process.exit(1);
}

// --- registration check (no quota) ---------------------------------------------
// AGY_PROBE_REG_ONLY=1: spawn agy with the driver's exact args, wait for init,
// kill, and report whether the bridge tools are in the init frame's tool list.
if (process.env.AGY_PROBE_REG_ONLY === "1") {
	const LOG = "/tmp/agy-reg-probe.log";
	const args = [
		"--add-dir", WorkCwd,
		"--add-dir", bridgeMcpConfigDir(),
		"--model", process.env.AGY_SMOKE_MODEL ?? "gemini-3.7-flash-medium",
		"--mode", "accept-edits",
		"--dangerously-skip-permissions",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--log-file", LOG,
	];
	console.log(`[reg] spawn: agy ${args.join(" ")}`);
	const child = spawn("agy", args, { cwd: WorkCwd, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	await new Promise((r) => setTimeout(r, 15_000));
	child.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 1_000));
	console.log(`[reg] first output: ${out.slice(0, 300) || "(none)"}`);
	try {
		const first = out.split("\n").find((l) => l.startsWith("{"));
		const init = JSON.parse(first).init;
		const tools = init.tools ?? [];
		console.log(`[reg] tool count: ${tools.length}`);
		console.log(`[reg] bridge tools: ${JSON.stringify(tools.filter((t) => /bridge|image_probe/i.test(t)))}`);
	} catch (e) {
		console.log(`[reg] init parse failed: ${e.message}`);
	}
	try {
		const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => /mcp|pi-bridge|bridge_image/i.test(l));
		console.log(`[reg] MCP log lines (${lines.length}):`);
		for (const l of lines.slice(0, 40)) console.log(`  ${l.slice(0, 300)}`);
	} catch (e) {
		console.log(`[reg] no log file: ${e.message}`);
	}
	await bridge.handle.close();
	// Override cwd (user data) is NEVER deleted; only a self-created temp dir.
	if (!probeCwdOverride) rmSync(WorkCwd, { recursive: true, force: true });
	process.exit(0);
}

// --- legacy driver turn ----------------------------------------------------------
const driver = new AgyDriver();
let answer = "";
const handle = await driver.run({
	cwd: WorkCwd,
	model: process.env.AGY_SMOKE_MODEL ?? "gemini-3.7-flash-medium",
	mode: "accept-edits",
	skipPermissions: true,
	prompt: PROMPT,
	timeoutMin: 3,
	inactivityMin: 2,
});
for (;;) {
	const a = await handle.next();
	if (!a) break;
	log({ t: "activity", activity: a });
	if (a.type === "text") answer += a.delta;
	if (a.type === "tool_start") console.log(`[agy tool: ${a.name}]`);
	if (a.type === "tool_error") console.log(`[agy tool error: ${JSON.stringify(a)}]`);
}
const outcome = await handle.outcome;
console.log(`[probe] outcome: ${JSON.stringify({ status: outcome.status, error: outcome.error ?? null })}`);

// --- verdict ---------------------------------------------------------------------
const norm = answer.toLowerCase();
const pass = toolCalls >= 1 && /left\s*=\s*green/.test(norm) && /right\s*=\s*yellow/.test(norm);
console.log(`[probe] toolCalls: ${toolCalls}`);
console.log(`[probe] answer: ${answer.trim() || "(none)"}`);
console.log(`[probe] VERDICT: ${pass ? "PASS: stream-json MCP image tool results reach the model" : "FAIL: image content in stream-json tool results does not reach the model"}`);

await driver.close("shutdown");
await bridge.handle.close();
// Override cwd (user data) is NEVER deleted; only a self-created temp dir.
if (!probeCwdOverride) rmSync(WorkCwd, { recursive: true, force: true });
console.log(`[probe] raw frames: ${RAW}`);
process.exit(pass ? 0 : 2);
