// Unit tests for the session/update → driver-event mapping and the
// cumulative-resend accumulator. Shapes are the live-captured ones from
// probe-logs/acp-traffic-run5.jsonl and run6-restart-load-tools.jsonl.

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mapStopReason, mapUpdate, TextAccumulator, toolName } from "../src/acp/events.js";

describe("acp/events mapUpdate", () => {
	test("agent_message_chunk maps to a text delta", () => {
		assert.deepEqual(
			mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HE" } }),
			{ kind: "text", delta: "HE" },
		);
	});

	test("agent_thought_chunk maps to a thought delta", () => {
		assert.deepEqual(
			mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } }),
			{ kind: "thought", delta: "thinking..." },
		);
	});

	test("user_message_chunk maps to replay (never live text)", () => {
		const mapped = mapUpdate({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "OLD USER" },
		});
		assert.deepEqual(mapped, { kind: "replay_user" });
	});

	test("tool_call derives the tool name from the title and carries rawInput", () => {
		const mapped = mapUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "33eb71a0",
			title: "Run create_file?",
			kind: "edit",
			status: "pending",
			rawInput: { TargetFile: "/x/probe.txt", CodeContent: "hello\n" },
		});
		assert.ok(mapped && mapped.kind === "tool_start");
		if (mapped.kind !== "tool_start") return;
		assert.equal(mapped.toolCallId, "33eb71a0");
		assert.equal(mapped.name, "create_file");
		assert.deepEqual(mapped.args, { TargetFile: "/x/probe.txt", CodeContent: "hello\n" });
	});

	test("tool_call_update completed carries rawOutput", () => {
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			rawOutput: "Create probe.txt",
		});
		assert.deepEqual(mapped, { kind: "tool_done", toolCallId: "t1", output: "Create probe.txt" });
	});

	test("MCP tool frames: args unwrap the arguments envelope, name from _meta", () => {
		// Verbatim shape from the phase-2 probe (bridge_echo through the real
		// server): title is "<server>_<tool>", the clean name hides in
		// _meta.mcp.tool, and rawInput wraps args in an MCP arguments envelope.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "e5a2e6d6eada432fbdb51c694b8e7300",
			title: "pi-bridge_bridge_echo",
			kind: "other",
			status: "pending",
			content: [],
			rawInput: { arguments: { text: "PROBE-9" } },
			_meta: { mcp: { tool: "bridge_echo", server: "pi-bridge" }, is_mcp_tool_call: true },
		});
		assert.ok(mapped && mapped.kind === "tool_start");
		if (mapped.kind !== "tool_start") return;
		assert.equal(mapped.name, "bridge_echo");
		assert.deepEqual(mapped.args, { text: "PROBE-9" });
	});

	test("completed tool content[] wins over rawOutput", () => {
		// Probe: rawOutput was the display title while content[] carried the
		// real payload text.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "THE RESULT" } }],
			rawOutput: "Run bridge_echo?",
		});
		assert.deepEqual(mapped, { kind: "tool_done", toolCallId: "t1", output: "THE RESULT" });
	});

	test("completed tool without text content falls back to rawOutput", () => {
		// Diff entries carry no text; rawOutput is the only display then.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "diff", path: "/x/a.txt", newText: "hello\n" }],
			rawOutput: "Running edit_file",
		});
		assert.deepEqual(mapped, { kind: "tool_done", toolCallId: "t1", output: "Running edit_file" });
	});

	test("tool_call_update failed maps to tool_error with the raw output as message", () => {
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "failed",
			rawOutput: "Tool call was approved but never executed.",
		});
		assert.deepEqual(mapped, {
			kind: "tool_error",
			toolCallId: "t1",
			message: "Tool call was approved but never executed.",
		});
	});

	test("tool_call_update in_progress maps to null (nothing to render)", () => {
		assert.equal(
			mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
			null,
		);
	});

	test("plan and available_commands_update map to null in phase 1", () => {
		assert.equal(mapUpdate({ sessionUpdate: "plan", entries: [] }), null);
		assert.equal(mapUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }), null);
	});

	test("garbage payloads map to null instead of throwing", () => {
		assert.equal(mapUpdate(null), null);
		assert.equal(mapUpdate("nope"), null);
		assert.equal(mapUpdate({}), null);
	});
});

describe("acp/events toolName", () => {
	test("extracts from Run/Running titles", () => {
		assert.equal(toolName("Run create_file?", "edit"), "create_file");
		assert.equal(toolName("Running edit_file", "edit"), "edit_file");
		assert.equal(toolName("Running view_file", "read"), "view_file");
	});

	test("falls back to the kind", () => {
		assert.equal(toolName(undefined, "read"), "read");
		assert.equal(toolName("mystery", undefined), "tool");
	});
});

describe("acp/events mapStopReason", () => {
	test("end_turn is a clean OK", () => {
		assert.deepEqual(mapStopReason("end_turn"), { status: "OK", aborted: false });
	});

	test("cancelled maps to aborted OK", () => {
		const mapped = mapStopReason("cancelled");
		assert.equal(mapped.aborted, true);
		assert.equal(mapped.status, "OK");
	});

	test("refusal is an error", () => {
		const mapped = mapStopReason("refusal");
		assert.equal(mapped.status, "ERROR");
		assert.match(mapped.error ?? "", /refused/);
	});
});

describe("acp/events TextAccumulator", () => {
	test("live deltas pass through unchanged", () => {
		const acc = new TextAccumulator();
		assert.equal(acc.append("HE"), "HE");
		assert.equal(acc.append("LLO"), "LLO");
		assert.equal(acc.text, "HELLO");
	});

	test("cumulative resend flips the mode and emits only the suffix", () => {
		const acc = new TextAccumulator();
		acc.append("1\n2\n3");
		// A cumulative sender repeats the full text.
		assert.equal(acc.append("1\n2\n3\n4"), "\n4");
		assert.equal(acc.text, "1\n2\n3\n4");
	});

	test("non-extending chunks in cumulative mode emit nothing", () => {
		const acc = new TextAccumulator();
		acc.append("abc");
		acc.append("abcdef");
		assert.equal(acc.append("ab"), null);
		assert.equal(acc.text, "abcdef");
	});

	test("never flips on compliant deltas (mid-token splits)", () => {
		const acc = new TextAccumulator();
		const emitted: string[] = [];
		// Run-5 style: numbers split mid-token across chunk boundaries.
		for (const d of ["\n39\n40\n4", "1\n42\n43"]) {
			const e = acc.append(d);
			if (e !== null) emitted.push(e);
		}
		assert.deepEqual(emitted, ["\n39\n40\n4", "1\n42\n43"]);
		assert.equal(acc.text, "\n39\n40\n41\n42\n43");
	});
});
