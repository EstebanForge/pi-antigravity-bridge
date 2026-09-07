// Live probe: does the ACP server deliver MCP tool-result IMAGE content to the
// model? Gated: AGY_ACP_LIVE=1 (spends quota).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/probe-acp-image-result.mjs
//
// Context (2026-09-05): bridge `read` of an image file drops the image block
// (blocksToText keeps text only), so agy never receives pixels for disk
// images and falls back to shell + ai-vision. The protocol-level question is
// whether returning {type:"image"} MCP content from a bridge tool would
// survive the trip to Gemini. This probe answers it directly: a local MCP
// server serves one tool whose result carries a real two-tone PNG; the model
// must name both halves from the TOOL RESULT (no image in the prompt).
//
// Verdict is printed; every raw frame lands in
// probe-logs/acp-image-result-traffic.jsonl (gitignored).

import fs from "node:fs";
import zlib from "node:zlib";
import { AcpConnection, resolveAcpBinary } from "../src/acp/connection.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}
const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");
console.log(`[probe] bin: ${bin}`);

// --- raw frame log ------------------------------------------------------------
const RAW = "probe-logs/acp-image-result-traffic.jsonl";
fs.mkdirSync("probe-logs", { recursive: true });
const raw = fs.createWriteStream(RAW, { flags: "w" });
const log = (obj) => raw.write(JSON.stringify(obj) + "\n");

// --- two-tone PNG: left GREEN, right YELLOW (not the red/blue pair the
// earlier image probes used, so a correct answer proves fresh perception) ------
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
// 64x64 RGB PNG; the color varies on X (left/right), not Y.
function twoTonePng() {
	const w = 64;
	const h = 64;
	const stride = 1 + w * 3;
	const buf = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const row = y * stride;
		buf[row] = 0; // filter: none
		for (let x = 0; x < w; x++) {
			const o = row + 1 + x * 3;
			if (x < w / 2) {
				buf[o] = 0; // green: r=0 g=255 b=0
				buf[o + 1] = 255;
				buf[o + 2] = 0;
			} else {
				buf[o] = 255; // yellow: r=255 g=255 b=0
				buf[o + 1] = 255;
				buf[o + 2] = 0;
			}
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2; // RGB
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
	"Call the bridge_image_probe tool once, then reply with ONLY the LEFT half color and RIGHT half color of the image it returned, like: LEFT=<color> RIGHT=<color>";

// --- bridge MCP server: one tool whose RESULT carries the image ----------------
let toolCalls = 0;
const bridge = await startMcpServer({
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
const mcpServers = () => [
	{
		name: "pi-bridge",
		type: "http",
		url: `http://127.0.0.1:${bridge.handle.port}/mcp`,
		headers: [{ name: TOKEN_HEADER, value: bridge.handle.token }],
	},
];

// --- connection -----------------------------------------------------------------
let answer = "";
const conn = new AcpConnection({
	bin,
	cwd: process.cwd(),
	mcpServers,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
	// First run default-denied the tool call ("Rejected by user") and the
	// model grepped the PNG's colors out of this script's source instead.
	// The probe measures transport, not permissions: allow the call.
	permissions: () => "auto",
	onUpdate: (_sessionId, update) => {
		log({ t: "update", update });
		if (
			typeof update === "object" &&
			update !== null &&
			update.sessionUpdate === "agent_message_chunk" &&
			typeof update.content?.text === "string"
		) {
			answer += update.content.text;
		}
	},
	onExit: (info) => console.error(`[acp] exited: ${JSON.stringify(info)}`),
});
await conn.start();
console.log(`[probe] server: ${conn.serverVersion()}`);
const info = await conn.newSession(process.cwd());
console.log(`[probe] session: ${info.sessionId}`);

log({ t: "prompt", text: PROMPT });
const started = Date.now();
const result = await conn.request(
	"session/prompt",
	{ sessionId: info.sessionId, prompt: [{ type: "text", text: PROMPT }] },
	180_000,
);
log({ t: "result", ms: Date.now() - started, result });
console.log(`[probe] stopReason: ${JSON.stringify(result)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);

// --- verdict ---------------------------------------------------------------------
const norm = answer.toLowerCase();
const pass = toolCalls === 1 && /left\s*=\s*green/.test(norm) && /right\s*=\s*yellow/.test(norm);
console.log(`[probe] toolCalls: ${toolCalls}`);
console.log(`[probe] answer: ${answer.trim() || "(none)"}`);
console.log(`[probe] VERDICT: ${pass ? "PASS: MCP image tool results reach the model" : "FAIL: image content in tool results does not reach the model"}`);

await conn.closeSession(info.sessionId).catch(() => {});
conn.kill();
await bridge.handle.close();
raw.end();
console.log(`[probe] raw frames: ${RAW}`);
process.exit(pass ? 0 : 2);
