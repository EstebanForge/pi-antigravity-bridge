// /agy auth tests against the scripted fake ACP server (authenticate ->
// {}), plus a failure path with a nonexistent binary. Fully offline.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { runAcpAuth } from "../src/acp/auth.js";

const FAKE_SERVER = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-"));
}

describe("acp/auth runAcpAuth", () => {
	test("sends authenticate with the oauth-personal method and succeeds", async () => {
		const dir = tmpDir();
		const logPath = path.join(dir, "fake-log.jsonl");
		const r = await runAcpAuth({
			bin: process.execPath,
			binArgs: [FAKE_SERVER],
			cwd: dir,
			extraEnv: { ACP_FAKE_SCENARIO: "happy", ACP_FAKE_LOG: logPath },
			timeoutMs: 15_000,
			tokenGraceMs: 200,
		});
		assert.equal(r.ok, true);
		assert.equal(r.error, undefined);
		const requests = fs
			.readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { method?: string; params?: { methodId?: string } });
		assert.ok(
			requests.some((m) => m.method === "authenticate" && m.params?.methodId === "oauth-personal"),
			"the authenticate RPC must carry the oauth-personal method id",
		);
	});

	test("a dead binary fails with an error, not a hang", async () => {
		const r = await runAcpAuth({
			bin: path.join(tmpDir(), "no-such-server.par"),
			timeoutMs: 5_000,
		});
		assert.equal(r.ok, false);
		assert.ok(r.error && r.error.length > 0);
	});

	test("a second concurrent run fails fast instead of racing the token write", async () => {
		const dir = tmpDir();
		const first = runAcpAuth({
			bin: process.execPath,
			binArgs: [FAKE_SERVER],
			cwd: dir,
			extraEnv: { ACP_FAKE_SCENARIO: "happy" },
			timeoutMs: 15_000,
			tokenGraceMs: 200,
		});
		const second = await runAcpAuth({
			bin: process.execPath,
			binArgs: [FAKE_SERVER],
			cwd: dir,
			timeoutMs: 15_000,
		});
		const a = await first;
		assert.equal(a.ok, true);
		assert.equal(second.ok, false);
		assert.match(second.error ?? "", /already running/);
	});
});
