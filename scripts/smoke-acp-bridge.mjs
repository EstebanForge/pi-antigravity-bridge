// Live smoke: bridge MCP server + ACP engine end-to-end (Gate F live).
// Gated: AGY_ACP_LIVE=1 (spends a small amount of quota).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     npx tsx scripts/smoke-acp-bridge.mjs
//
// Proves the last load-bearing unknown of the ACP adoption: the REAL agy ACP
// server can (a) accept our mcpServers registration (port + shared-secret
// header), (b) list the bridge's tools over Streamable HTTP, (c) invoke one,
// and (d) finish its turn with the tool result in hand. The bridge deps here
// answer directly (no pi round-trip) — that half is engine-independent and was
// proven live on the legacy engine. What this isolates is the agy-side HTTP
// MCP client, which no fake server can stand in for.

import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary } from "../src/acp/connection.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

const ECHO_TOKEN = "BRIDGE-E2E-777";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");
console.log(`[smoke] bin: ${bin}`);

// --- 1. Real bridge MCP server with a canned echo tool ---------------------
const bridgeLog = [];
let sawList = 0;
let sawCallOk = 0;
const bridge = await startMcpServer(
	{
		listTools: () => {
			sawList += 1;
			return [
				{
					name: "bridge_echo",
					description:
						"Echoes the given text back, prefixed with ECHO:. Use this tool when asked to.",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string", description: "Text to echo" } },
						required: ["text"],
					},
				},
			];
		},
		onToolCall: async (_callId, name, args) => {
			if (name !== "bridge_echo") {
				return { content: [{ type: "text", text: `Error: unknown tool ${name}` }], isError: true };
			}
			sawCallOk += 1;
			return {
				content: [{ type: "text", text: `ECHO:${typeof args.text === "string" ? args.text : ""}` }],
				isError: false,
			};
		},
	},
	{ log: (s, d) => bridgeLog.push(`${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`) },
);
if (!bridge.ok || !bridge.handle) {
	console.error(`[smoke] bridge failed to start: ${bridge.reason}`);
	process.exit(1);
}
const { port, token } = bridge.handle;
console.log(`[smoke] bridge: http://127.0.0.1:${port}/mcp (token: ${token.slice(0, 8)}...)`);

// --- 2. ACP engine registered against the running bridge --------------------
const toolCalls = [];
const driver = new AcpDriver({
	bin,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
	mcpServers: () => [
		{
			name: "pi-bridge",
			type: "http",
			url: `http://127.0.0.1:${port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: token }],
		},
	],
});

const controller = new AbortController();
const text = [];
const toolStarts = [];
const handle = await driver.run({
	cwd: process.cwd(),
	model: "gemini-3.7-flash",
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	prompt: `Call the bridge_echo tool with text exactly ${ECHO_TOKEN}, then reply with the exact text the tool returned and nothing else. Use no tools other than bridge_echo.`,
	signal: controller.signal,
	timeoutMin: 3,
});

const collecting = (async () => {
	for (;;) {
		const activity = await handle.next();
		if (activity === null) return;
		if (activity.type === "text") {
			text.push(activity.delta);
			process.stdout.write(activity.delta);
		} else {
			// The driver surfaces bridge tool calls as tool_start/tool_done.
			if (activity.type === "tool_start") toolStarts.push({ name: activity.name, args: activity.args });
			console.log(`\n[activity] ${JSON.stringify(activity)}`);
		}
	}
})();

const outcome = await handle.outcome;
await collecting;
const joined = text.join("");
console.log(`\n[smoke] outcome: ${JSON.stringify({ status: outcome.status, aborted: outcome.aborted, error: outcome.error })}`);
console.log(`[smoke] text: ${joined}`);
console.log(`[smoke] tool calls seen by driver: ${JSON.stringify(toolStarts)}`);
console.log(`[smoke] bridge log: ${JSON.stringify(bridgeLog)}`);
console.log(`[smoke] snapshot: ${JSON.stringify(driver.snapshot().acp)}`);

await driver.close("shutdown");
await bridge.handle.close();

const ok =
	outcome.status === "OK" &&
	joined.includes(`ECHO:${ECHO_TOKEN}`) &&
	toolStarts.some((t) => t.name === "bridge_echo") &&
	sawList > 0 &&
	sawCallOk > 0;
console.log(ok ? "\nACP BRIDGE SMOKE OK." : "\nACP BRIDGE SMOKE FAILED.");
process.exit(ok ? 0 : 1);
