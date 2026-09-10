// Regression: bridge suppression must span the WHOLE delegated `agy -p` run.
// The old 5s grace timer re-enabled the pi-bridge entries mid-run; agy watches
// mcp_config.json (ReloadMcpConfig) and reconnected to the live host bridge,
// producing fail-closed "no active antigravity turn" call-tool-fail toasts
// (observed live 2026-09-09: deny ~50s into a peer-review delegation). The
// release may fire only when the delegated process closes.
//
// Seam: registerAskAntigravityTool with AGY_BIN pointed at a fake binary that
// outlives the old 5s timer. mcp-registration is mocked (the real one rewrites
// the user's global ~/.gemini/config/mcp_config.json); the spies record WHEN
// acquire/release fire relative to process close.
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const suppressionEvents: Array<{ event: "acquire" | "release"; t: number }> = [];

vi.mock("../src/mcp-registration.js", () => ({
	acquireBridgeSuppression: () => {
		suppressionEvents.push({ event: "acquire", t: Date.now() });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			suppressionEvents.push({ event: "release", t: Date.now() });
		};
	},
}));

import { registerAskAntigravityTool } from "../src/ask-tool.js";

// The fake agy must outlive the OLD 5s grace so an early timer release is
// observable as a release timestamp ~1s before process close.
const FAKE_AGY_SLEEP_MS = 6000;

function makeFakeAgyBin(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
	const bin = path.join(dir, "agy");
	// Ignore every CLI arg the tool passes; just stay alive, then exit 0.
	fs.writeFileSync(bin, `#!/usr/bin/env bash\nexec sleep ${FAKE_AGY_SLEEP_MS / 1000}\n`, {
		mode: 0o755,
	});
	return bin;
}

test(
	"bridge suppression releases at process close, never on an early timer",
	{ timeout: 20_000 },
	async () => {
		const bin = makeFakeAgyBin();
		const prevBin = process.env.AGY_BIN;
		process.env.AGY_BIN = bin;
		try {
			const tools: Array<{ execute: (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: Record<string, unknown>) => Promise<unknown> }> = [];
			const fakePi = {
				registerTool: (tool: { execute: (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: Record<string, unknown>) => Promise<unknown> }) =>
					tools.push(tool),
			} as unknown as ExtensionAPI;
			await registerAskAntigravityTool(fakePi, []);
			expect(tools).toHaveLength(1);

			const start = Date.now();
			// Empty ctx: the executor's circular-delegation guard dereferences
			// ctx.model, so the context must exist even when bare.
			await tools[0].execute("t1", { prompt: "noop", cwd: process.cwd(), timeoutMinutes: 1 }, undefined, undefined, {});
			const done = Date.now();

			// The fake agy really ran to completion (and outlived the old grace).
			expect(done - start).toBeGreaterThanOrEqual(FAKE_AGY_SLEEP_MS - 500);

			const acquires = suppressionEvents.filter((e) => e.event === "acquire");
			const releases = suppressionEvents.filter((e) => e.event === "release");
			expect(acquires).toHaveLength(1);
			expect(releases).toHaveLength(1);

			// Old bug: the timer released at ~5s while the run continued to ~6s.
			// The release must land with (or after) the process's sleep, not ~1s
			// ahead of completion.
			expect(releases[0].t).toBeGreaterThanOrEqual(start + FAKE_AGY_SLEEP_MS - 500);
		} finally {
			if (prevBin === undefined) delete process.env.AGY_BIN;
			else process.env.AGY_BIN = prevBin;
			fs.rmSync(path.dirname(bin), { recursive: true, force: true });
		}
	},
);
