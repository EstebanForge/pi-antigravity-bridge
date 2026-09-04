// H1 regression: stream-json frames that split across pipe chunks must be
// buffered and reassembled, not dropped. Drives AgyDriver against the fake
// agy in tests/helpers/fake-agy-bin/agy (resolved via PATH), whose reply is
// deliberately split across two stdout writes mid-line.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { AgyDriver } from "../src/driver.js";
import type { DriverActivity } from "../src/driver-types.js";

const FAKE_BIN_DIR = path.join(import.meta.dirname, "helpers", "fake-agy-bin");

describe("stream-json driver stdout framing (H1)", () => {
	test("frames split across pipe chunks are reassembled", async () => {
		process.env.PATH = `${FAKE_BIN_DIR}:${process.env.PATH}`;
		const driver = new AgyDriver();
		const handle = await driver.run({
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 0.5,
			inactivityMin: 0.5,
		});
		const activities: DriverActivity[] = [];
		const collecting = (async () => {
			for (;;) {
				const activity = await handle.next();
				if (activity === null) return;
				activities.push(activity);
			}
		})();
		const outcome = await handle.outcome;
		await collecting;

		// Pre-fix, the split agent_response frame was dropped whole and the
		// response fell back to the result body ("RESULT-BODY").
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.conversationId, "conv-777");
		assert.equal(outcome.response, "HALF-ONE-HALF-TWO");
		const text = activities
			.filter((a): a is Extract<DriverActivity, { type: "text" }> => a.type === "text")
			.map((a) => a.delta)
			.join("");
		assert.equal(text, "HALF-ONE-HALF-TWO");
	});
});
