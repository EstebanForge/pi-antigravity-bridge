// Live phase-2 probe for the ACP engine. Gated: AGY_ACP_LIVE=1 (spends quota).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/probe-acp-phase2.mjs
//
// Answers the four open shape questions phase 2 needs:
//   1. agent_thought_chunk shape on a clean (no-tool) prompt
//   2. a real multi-region image (64x64 PNG, top red / bottom blue) end-to-end
//   3. full tool_call / tool_call_update frames: content[] vs rawOutput
//   4. the /plan command flow: what updates and stop reasons it produces
// Every raw frame lands in probe-logs/acp-phase2-traffic.jsonl (gitignored).

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

// --- raw frame log ----------------------------------------------------------
const RAW = "probe-logs/acp-phase2-traffic.jsonl";
fs.mkdirSync("probe-logs", { recursive: true });
const raw = fs.createWriteStream(RAW, { flags: "w" });
const log = (obj) => raw.write(JSON.stringify(obj) + "\n");

// --- minimal two-tone PNG (64x64, top red / bottom blue) --------------------
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
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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
	const rawBuf = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const row = y * stride;
		rawBuf[row] = 0; // filter: none
		const top = y < h / 2;
		for (let x = 0; x < w; x++) {
			const o = row + 1 + x * 3;
			rawBuf[o] = top ? 255 : 0;
			rawBuf[o + 1] = 0;
			rawBuf[o + 2] = top ? 0 : 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(rawBuf)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const PNG_B64 = twoTonePng().toString("base64");
console.log(`[probe] png: ${PNG_B64.length} b64 chars`);

// --- bridge echo server (for the tool-frame probe) ---------------------------
let currentLabel = "setup";
const bridge = await startMcpServer({
	listTools: () => [
		{
			name: "bridge_echo",
			description: "Echoes the given text back, prefixed with ECHO:. Use this tool when asked to.",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
	],
	onToolCall: async (_callId, name, args) => ({
		content: [{ type: "text", text: `ECHO:${typeof args.text === "string" ? args.text : ""}` }],
		isError: false,
	}),
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

// --- connection ---------------------------------------------------------------
const conn = new AcpConnection({
	bin,
	cwd: process.cwd(),
	mcpServers,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
	onUpdate: (_sessionId, update) => log({ t: "update", label: currentLabel, update }),
	onExit: (info) => console.error(`[acp] exited: ${JSON.stringify(info)}`),
});
await conn.start();
console.log(`[probe] server: ${conn.serverVersion()}`);
const info = await conn.newSession(process.cwd());
log({ t: "session-new", info });
console.log(`[probe] session: ${info.sessionId}`);

async function rawPrompt(label, blocks) {
	currentLabel = label;
	log({
		t: "prompt",
		label,
		blocks: blocks.map((b) =>
			b.type === "image" ? { ...b, data: `${b.data.slice(0, 24)}...(${b.data.length} chars)` } : b,
		),
	});
	const started = Date.now();
	const result = await conn.request("session/prompt", { sessionId: info.sessionId, prompt: blocks }, 180_000);
	log({ t: "result", label, ms: Date.now() - started, result });
	console.log(`[probe] ${label}: ${JSON.stringify(result)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
	return result;
}

// 1. thought chunk shape on a clean, no-tool prompt
await rawPrompt("thought", [
	{ type: "text", text: "What is 17*23? Reason step by step before answering, then reply with just the number." },
]);

// 2. real image, verifiable content
await rawPrompt("image", [
	{ type: "image", data: PNG_B64, mimeType: "image/png" },
	{
		type: "text",
		text: "The image has two horizontal halves, each a solid color. Name the TOP half color and the BOTTOM half color in one line.",
	},
]);

// 3. tool frames: full tool_call + tool_call_update (content[] vs rawOutput)
await rawPrompt("tool", [
	{ type: "text", text: "Call the bridge_echo tool with text exactly PROBE-9, then reply with the exact text it returned and nothing else." },
]);

// 4. the /plan command flow (server-intercepted slash command)
await rawPrompt("plan", [{ type: "text", text: "/plan Organize a small birthday party for 8 people." }]);

await conn.closeSession(info.sessionId).catch(() => {});
conn.kill();
await bridge.handle.close();
raw.end();
console.log(`[probe] raw frames: ${RAW}`);
