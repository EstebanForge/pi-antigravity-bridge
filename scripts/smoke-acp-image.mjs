// Live smoke: image prompt end-to-end through OUR stack (AcpDriver).
// Gated: AGY_ACP_LIVE=1 (spends a small amount of quota).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/smoke-acp-image.mjs
//
// Builds a 64x64 PNG (top half red, bottom half blue) in-process, sends it
// through driver.run({images}), and asserts the model identifies both halves.

import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary } from "../src/acp/connection.js";
import zlib from "node:zlib";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}
const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");

// --- the same two-tone PNG the probe uses -----------------------------------
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
		rawBuf[row] = 0;
		const top = y < h / 2;
		for (let x = 0; x < w; x++) {
			const o = row + 1 + x * 3;
			rawBuf[o] = top ? 255 : 0;
			rawBuf[o + 2] = top ? 0 : 255;
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
		chunk("IDAT", zlib.deflateSync(rawBuf)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const driver = new AcpDriver({
	bin,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
});
const controller = new AbortController();
const text = [];
const handle = await driver.run({
	cwd: process.cwd(),
	model: "gemini-3.7-flash",
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	prompt: "The image has two horizontal halves, each a solid color. Name the TOP half color and the BOTTOM half color in one line.",
	images: [{ data: twoTonePng().toString("base64"), mimeType: "image/png" }],
	signal: controller.signal,
	timeoutMin: 2,
});
const collecting = (async () => {
	for (;;) {
		const activity = await handle.next();
		if (activity === null) return;
		if (activity.type === "text") {
			text.push(activity.delta);
			process.stdout.write(activity.delta);
		}
	}
})();
const outcome = await handle.outcome;
await collecting;
const joined = text.join("").toLowerCase();
console.log(`\n[smoke] outcome: ${JSON.stringify({ status: outcome.status, aborted: outcome.aborted, error: outcome.error })}`);
console.log(`[smoke] text: ${text.join("")}`);
await driver.close("shutdown");
const ok = outcome.status === "OK" && joined.includes("red") && joined.includes("blue");
console.log(ok ? "\nACP IMAGE SMOKE OK." : "\nACP IMAGE SMOKE FAILED.");
process.exit(ok ? 0 : 1);
