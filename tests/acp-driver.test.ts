// AcpDriver integration tests against a scripted fake ACP server
// (tests/helpers/fake-acp-server.mjs, spawned over stdio). No quota, no
// network: the fake speaks the exact wire shape captured in probe-logs/.

import { afterAll, describe, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpDriver } from "../src/acp/driver.js";
import type { DriverActivity } from "../src/driver-types.js";

const FAKE_SERVER = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));
const SESSION_ID = "fake-session-0001";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-driver-"));
}

interface DriverRun {
	driver: AcpDriver;
	handle: Awaited<ReturnType<AcpDriver["run"]>>;
	activities: DriverActivity[];
	_logPath: string;
	cleanup: () => void;
}

async function runDriver(
	scenario: string,
	opts: {
		prompt?: string;
		conversationId?: string | null;
		timeoutMin?: number;
		signal?: AbortSignal;
		onHandle?: (handle: Awaited<ReturnType<AcpDriver["run"]>>) => void;
	} = {},
): Promise<DriverRun> {
	const dir = tmpDir();
	const logPath = path.join(dir, "fake-log.jsonl");
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [FAKE_SERVER],
		extraEnv: { ACP_FAKE_SCENARIO: scenario, ACP_FAKE_LOG: logPath },
		log: () => {},
	});
	const activities: DriverActivity[] = [];
	const controller = new AbortController();
	const handle = await driver.run({
		cwd: dir,
		model: "gemini-3.8-flash",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		conversationId: opts.conversationId ?? null,
		prompt: opts.prompt ?? "hi",
		timeoutMin: opts.timeoutMin,
		signal: opts.signal ?? controller.signal,
	});
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			activities.push(activity);
		}
	})();
	opts.onHandle?.(handle);
	const outcome = await handle.outcome;
	await collecting;
	return {
		driver,
		handle,
		activities,
		cleanup: () => {
			controller.abort();
			fs.rmSync(dir, { recursive: true, force: true });
		},
		_logPath: logPath,
	};
}

function textOf(activities: DriverActivity[]): string {
	return activities
		.filter((a): a is Extract<DriverActivity, { type: "text" }> => a.type === "text")
		.map((a) => a.delta)
		.join("");
}

function sentRequests(logPath: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const fn of cleanups) fn();
});

async function tracked(scenario: string, opts: Parameters<typeof runDriver>[1] = {}) {
	const run = await runDriver(scenario, opts);
	cleanups.push(run.cleanup);
	return run;
}

describe("acp/driver happy path", () => {
	test("streams text deltas, applies the full model slug, ends OK", async () => {
		const run = await tracked("happy", { prompt: "hi" });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.aborted, false);
		assert.equal(outcome.conversationId, SESSION_ID);
		assert.equal(outcome.response, "HELLO");
		assert.equal(textOf(run.activities), "HELLO");

		const requests = sentRequests(run._logPath);
		const setModel = requests.find((r) => r.method === "session/set_config_option") as {
			params: { configId: string; value: string };
		};
		// Gate A: full slug with the effort tier baked in.
		assert.equal(setModel.params.configId, "model");
		assert.equal(setModel.params.value, "gemini-3.8-flash-low");
		const mode = requests.find(
			(r) => r.method === "session/set_config_option" && (r.params as { configId: string }).configId === "mode",
		) as { params: { value: string } };
		assert.equal(mode.params.value, "yolo");
		const prompt = requests.find((r) => r.method === "session/prompt") as { params: { prompt: unknown[] } };
		assert.deepEqual(prompt.params.prompt, [{ type: "text", text: "hi" }]);
	});

	test("registers the bridge on session/new and session/load", async () => {
		// Load flow: session/load carries mcpServers; session/new is NOT called
		// when the load succeeds.
		const load = await tracked("load-replay", { conversationId: SESSION_ID, prompt: "live" });
		await load.handle.outcome;
		const loadReqs = sentRequests(load._logPath);
		const loaded = loadReqs.find((r) => r.method === "session/load") as { params: { mcpServers: unknown[] } };
		assert.ok(Array.isArray(loaded.params.mcpServers));
		assert.equal(loadReqs.find((r) => r.method === "session/new"), undefined);

		// Fresh flow: session/new carries mcpServers.
		const fresh = await tracked("happy", { prompt: "hi" });
		await fresh.handle.outcome;
		const newReqs = sentRequests(fresh._logPath);
		const created = newReqs.find((r) => r.method === "session/new") as { params: { mcpServers: unknown[] } };
		assert.ok(Array.isArray(created.params.mcpServers));
	});
});

describe("acp/driver load replay (run 6 rules)", () => {
	test("session/load history replay never reaches pi as live text", async () => {
		const run = await tracked("load-replay", { conversationId: SESSION_ID, prompt: "live" });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "OK");
		const text = textOf(run.activities);
		assert.equal(text, "LIVE-1LIVE-2");
		assert.ok(!text.includes("OLD"), "replay text leaked into live activities");
	});

	test("load failure falls back to a fresh session", async () => {
		const run = await tracked("load-fails", { conversationId: "gone", prompt: "hi" });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.conversationId, SESSION_ID);
	});
});

describe("acp/driver permission policy (auto)", () => {
	test("request_permission is answered in-connection with allow", async () => {
		const run = await tracked("permission", { prompt: "make the file" });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "OK");
		assert.equal(textOf(run.activities), "PERMIS");
		const log = sentRequests(run._logPath);
		const answer = log.find((r) => (r as { _permissionAnswer?: string })._permissionAnswer) as {
			_permissionAnswer: string;
		};
		assert.equal(answer._permissionAnswer, "allow");
	});
});

describe("acp/driver Gate D abort", () => {
	test("cancel-unsupported (-32601) falls back to teardown and reports aborted", async () => {
		const controller = new AbortController();
		const started = runDriver("cancel-unsupported", { prompt: "count", signal: controller.signal });
		// Give the fake a moment to start streaming, then abort.
		await new Promise((r) => setTimeout(r, 400));
		controller.abort();
		const run = await started;
		const outcome = await run.handle.outcome;
		assert.equal(outcome.aborted, true);
		assert.equal(run.driver.state, "dead");
		// The -32601 probe result must be remembered per connection.
		const acp = run.driver.snapshot().acp;
		assert.ok(acp, "acp snapshot block present");
		assert.equal(acp.cancelSupported, false);
		const requests = sentRequests(run._logPath);
		const cancel = requests.find((r) => r.method === "session/cancel");
		assert.ok(cancel, "driver should have probed session/cancel first");
		run.cleanup();
	});
});

describe("acp/driver timers", () => {
	test("overall deadline fires and fails the turn on a silent server", async () => {
		const run = await tracked("slow", { prompt: "hang", timeoutMin: 0.03 });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /deadline/);
		assert.equal(run.driver.state, "dead");
	});

	test("stale connection's late exit never fails the replacement turn", async () => {
		// Live race, hit during the parity run: RC01's signal handler intercepts
		// SIGTERM and the killed server outlives its replacement by seconds.
		// The old connection's exit used to clobber #conn and fail the recovery
		// turn with the old stderr. Deterministic version: the fake lingers
		// 1.5s on SIGTERM while turn 2 runs in a fresh process.
		const dir = tmpDir();
		const driver = new AcpDriver({
			bin: process.execPath,
			binArgs: [FAKE_SERVER],
			extraEnv: {
				ACP_FAKE_SCENARIO: "park",
				ACP_FAKE_CANCEL_UNSUPPORTED: "1",
				ACP_FAKE_SLOW_DEATH_MS: "1500",
				ACP_FAKE_LOG: path.join(dir, "log.jsonl"),
			},
			log: () => {},
		});
		cleanups.push(() => {
			void driver.close("shutdown");
			fs.rmSync(dir, { recursive: true, force: true });
		});
		// Turn 1: parks open, abort tears the connection down (prompt RPC
		// rejection settles it aborted immediately, the process lingers).
		const controller = new AbortController();
		const h1 = await driver.run({
			cwd: dir,
			model: "gemini-3.8-flash",
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt: "park me",
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 400));
		controller.abort();
		const o1 = await h1.outcome;
		assert.equal(o1.aborted, true);
		// Turn 2 spawns while the old process is still dying. Its late exit
		// must be ignored; turn 2 runs to completion.
		const h2 = await driver.run({
			cwd: dir,
			model: "gemini-3.8-flash",
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt: "say hi",
		});
		const o2 = await h2.outcome;
		assert.equal(o2.status, "OK");
		assert.match(o2.response, /P2/);
	});

	test("park pauses the overall deadline; kickIdle resumes it (remaining budget)", async () => {
		// Scenario "slow": the fake never responds. Budget 1.2s: park at ~0.1s
		// (deadline freezes), then unpark (deadline resumes with the remaining
		// budget and fires at ~1.6s). A broken pause would fire at 1.2s.
		const dir = tmpDir();
		const driver = new AcpDriver({
			bin: process.execPath,
			binArgs: [FAKE_SERVER],
			extraEnv: { ACP_FAKE_SCENARIO: "slow", ACP_FAKE_LOG: path.join(dir, "log.jsonl") },
			log: () => {},
		});
		cleanups.push(() => {
			void driver.close("shutdown");
			fs.rmSync(dir, { recursive: true, force: true });
		});
		const handle = await driver.run({
			cwd: dir,
			model: "gemini-3.8-flash",
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt: "hang",
			timeoutMin: 0.02,
		});
		// Park at ~0.1s: the 1.2s deadline freezes with ~1.1s remaining.
		handle.pushExternal({ type: "bridge_call", callId: "c1", name: "ask_user_question", args: {} });
		await new Promise((r) => setTimeout(r, 400));
		// Unpark: the deadline resumes with its remaining budget and fires.
		driver.kickIdle();
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /deadline/);
	});
});

describe("acp/driver auth", () => {
	test("auth-required surfaces AcpAuthError guidance in the turn error", async () => {
		const run = await tracked("auth-required", { prompt: "hi" });
		const outcome = await run.handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /acp-auth/);
	});
});
