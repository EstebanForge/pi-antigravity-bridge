// Pins for the approval-gate shadow factory (docs/TODO.md 2.8 V1).
// The shadow tool is the load-bearing piece of the approval gate: marker
// calls must NEVER reach the real builtin, non-marker calls must behave
// exactly like the builtin, and denials must throw (pi converts thrown
// errors into error tool results carrying the message).
//
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	GATE_MARKER,
	MARKER_FIELDS,
	createShadowTool,
	stripMarkerFields,
	withGateMarkerSchema,
	type AnyToolDefinition,
	type GateDecision,
} from "../src/approval-gate.js";

const ctxStub = { hasUI: false } as import("@earendil-works/pi-coding-agent").ExtensionContext;

interface ExecuteLog {
	params: Record<string, unknown>;
	toolCallId: string;
}

function baseBashTool() {
	const log: ExecuteLog[] = [];
	const base: AnyToolDefinition = {
		name: "bash",
		label: "Bash",
		description: "runs a shell command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		},
		execute: async (toolCallId, params) => {
			log.push({ toolCallId, params: params as Record<string, unknown> });
			return {
				content: [{ type: "text", text: `RAN:${(params as { command: string }).command}` }],
				details: { ran: true },
			};
		},
	};
	return { base, log };
}

const allow = (): GateDecision => ({ allow: true });
const denyWith = (reason: string) => (): GateDecision => ({ allow: false, reason });

test("shadow keeps identity and injects marker fields into the schema", () => {
	const { base } = baseBashTool();
	const shadow = createShadowTool(base, allow);
	assert.equal(shadow.name, "bash");
	assert.equal(shadow.label, "Bash");
	assert.equal(shadow.description, "runs a shell command");
	const props = (shadow.parameters as { properties: Record<string, unknown> }).properties;
	assert.ok(props.command, "command prop preserved");
	for (const field of MARKER_FIELDS) assert.ok(props[field], `marker field ${field} present`);
	// base schema untouched
	const baseProps = (base.parameters as { properties: Record<string, unknown> }).properties;
	assert.equal(baseProps[GATE_MARKER], undefined);
});

test("marker call with allow: synthetic result, builtin never executes", async () => {
	const { base, log } = baseBashTool();
	let policyCalls = 0;
	const shadow = createShadowTool(base, (call) => {
		policyCalls += 1;
		assert.equal(call.tool, "run_command");
		return { allow: true };
	});
	const result = await shadow.execute(
		"t1",
		{ command: "npm test", cwd: "/w", [GATE_MARKER]: true, __agyTool: "run_command" },
		undefined,
		undefined,
		ctxStub,
	);
	assert.equal(policyCalls, 1);
	assert.equal(log.length, 0, "builtin must not run for marker calls");
	const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
	assert.match(text, /Approved by approval gate: run_command/);
	assert.match(text, /No local execution/);
});

test("marker call with deny: throws with the reason, builtin never executes", async () => {
	const { base, log } = baseBashTool();
	const shadow = createShadowTool(base, denyWith("rm is not allowed"));
	await assert.rejects(
		shadow.execute("t2", { command: "rm -rf /", [GATE_MARKER]: true }, undefined, undefined, ctxStub),
		/rm is not allowed/,
	);
	assert.equal(log.length, 0);
});

test("policy throw fails closed: throws, builtin never executes", async () => {
	const { base, log } = baseBashTool();
	const shadow = createShadowTool(base, () => {
		throw new Error("policy exploded");
	});
	await assert.rejects(
		shadow.execute("t3", { command: "ls", [GATE_MARKER]: true }, undefined, undefined, ctxStub),
		/approval gate policy failed: policy exploded/,
	);
	assert.equal(log.length, 0);
});

test("pre-aborted signal throws without consulting the policy", async () => {
	const { base, log } = baseBashTool();
	let policyCalls = 0;
	const shadow = createShadowTool(base, () => {
		policyCalls += 1;
		return allow();
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		shadow.execute("t4", { command: "ls", [GATE_MARKER]: true }, controller.signal, undefined, ctxStub),
		/aborted before a decision/,
	);
	assert.equal(policyCalls, 0);
	assert.equal(log.length, 0);
});

test("gate branch keys on the marker value, not on other __agy fields", async () => {
	const { base, log } = baseBashTool();
	const shadow = createShadowTool(base, allow);
	const result = await shadow.execute(
		"t5",
		{ command: "echo hi", [GATE_MARKER]: true, __agyTicket: "x", __agyTool: "run_command" },
		undefined,
		undefined,
		ctxStub,
	);
	// marker true -> gate path (approved here), never delegation
	assert.equal(log.length, 0);
	assert.ok((result.content as Array<{ text?: string }>)[0]?.text?.includes("Approved"));
});

test("non-marker call delegates verbatim to the builtin", async () => {
	const { base, log } = baseBashTool();
	const shadow = createShadowTool(base, denyWith("no"));
	const result = await shadow.execute("t6", { command: "echo hi" }, undefined, undefined, ctxStub);
	assert.equal(log.length, 1);
	assert.deepEqual(log[0].params, { command: "echo hi" }, "builtin receives clean params");
	assert.equal((result.content as Array<{ text?: string }>)[0]?.text, "RAN:echo hi");
});

test("abort while the policy is pending unblocks execute with a throw", async () => {
	const { base, log } = baseBashTool();
	const controller = new AbortController();
	const shadow = createShadowTool(base, () => {
		controller.abort();
		return allow();
	});
	await assert.rejects(
		shadow.execute("t8", { command: "ls", [GATE_MARKER]: true }, controller.signal, undefined, ctxStub),
		/aborted before a decision/,
	);
	assert.equal(log.length, 0);
});


test("abort while the policy is still pending (async policy) unblocks execute", async () => {
	const { base, log } = baseBashTool();
	const controller = new AbortController();
	const shadow = createShadowTool(base, async () => {
		await new Promise((r) => setTimeout(r, 250));
		return allow();
	});
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(
		shadow.execute("t9", { command: "ls", [GATE_MARKER]: true }, controller.signal, undefined, ctxStub),
		/aborted before a decision/,
	);
	assert.equal(log.length, 0);
});


test("deny without reason falls back to a generic message naming the tool", async () => {
	const { base } = baseBashTool();
	const shadow = createShadowTool(base, () => ({ allow: false }));
	await assert.rejects(
		shadow.execute("t7", { command: "ls", [GATE_MARKER]: true }, undefined, undefined, ctxStub),
		/blocked by approval gate \(bash\)/,
	);
});

test("stripMarkerFields removes exactly the marker fields", () => {
	const stripped = stripMarkerFields({
		command: "x",
		[GATE_MARKER]: true,
		__agyTicket: "t",
		__agyTool: "run_command",
	});
	assert.deepEqual(stripped, { command: "x" });
});

test("withGateMarkerSchema does not mutate the base schema object", () => {
	const { base } = baseBashTool();
	const before = JSON.stringify(base.parameters);
	withGateMarkerSchema(base.parameters);
	assert.equal(JSON.stringify(base.parameters), before);
});
