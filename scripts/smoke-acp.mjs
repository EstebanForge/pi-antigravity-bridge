// Live smoke for the ACP engine through OUR driver stack (AcpDriver).
// Gated: AGY_ACP_LIVE=1 (spends a small amount of quota).
//
//   AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
//     node scripts/smoke-acp.mjs
//
// Verifies end-to-end: spawn -> initialize -> session/new -> set_config_option
// (model) -> prompt streaming through events.ts -> result. No tools, no writes.

import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary } from "../src/acp/connection.js";

const scenario = process.argv[2] || "happy";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const bin = resolveAcpBinary(process.env.AGY_ACP_BIN || "");
console.log(`[smoke] bin: ${bin}`);

const driver = new AcpDriver({
	bin,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
});

const controller = new AbortController();
const activities = [];
const handle = await driver.run({
	cwd: process.cwd(),
	model: "gemini-3.7-flash",
	effort: "low",
	mode: "accept-edits",
	skipPermissions: true,
	prompt: "Reply with exactly: ACP SMOKE OK. Do not use any tools.",
	signal: controller.signal,
	timeoutMin: 2,
});

const collecting = (async () => {
	for (;;) {
		const activity = await handle.next();
		if (activity === null) return;
		if (activity.type === "text") {
			activities.push(activity.delta);
			process.stdout.write(activity.delta);
		} else {
			console.log(`[activity] ${JSON.stringify(activity)}`);
		}
	}
})();

const outcome = await handle.outcome;
await collecting;
console.log(`\n[smoke] outcome: ${JSON.stringify({ status: outcome.status, aborted: outcome.aborted, error: outcome.error })}`);
console.log(`[smoke] text: ${activities.join("")}`);
console.log(`[smoke] snapshot: ${JSON.stringify(driver.snapshot().acp)}`);
await driver.close("shutdown");
const ok = outcome.status === "OK" && activities.join("").includes("ACP SMOKE OK");
process.exit(ok ? 0 : 1);
