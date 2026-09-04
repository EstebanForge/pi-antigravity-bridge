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

	test("completed tool without text content falls back to rawOutput and carries the diff", () => {
		// Diff entries carry no text (rawOutput is the only display text), but
		// the native diff must still ride to the provider (Gate C rendering).
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "diff", path: "/x/a.txt", newText: "hello\n" }],
			rawOutput: "Running edit_file",
		});
		assert.deepEqual(mapped, {
			kind: "tool_done",
			toolCallId: "t1",
			output: "Running edit_file",
			diff: { path: "/x/a.txt", newText: "hello\n" },
		});
	});

	test("completed edit diff carries oldText when the server sends it", () => {
		// Run-6 native edit shape: {type:"diff", path, newText, oldText?}.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t2",
			status: "completed",
			content: [{ type: "diff", path: "/x/b.txt", oldText: "a\n", newText: "a\nb\n" }],
		});
		assert.deepEqual(mapped, {
			kind: "tool_done",
			toolCallId: "t2",
			output: undefined,
			diff: { path: "/x/b.txt", oldText: "a\n", newText: "a\nb\n" },
		});
	});

	test("run-6 edit: diff rides on the PENDING tool_call frame", () => {
		// Verbatim shape from probe-logs/acp-traffic-run6...jsonl:10. The diff
		// arrives on the pending frame; the completed update repeats none of it
		// (supersede quirk), so this is the only place it can be captured.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "33eb71a04aae4d4c9b85081f20ab5169",
			title: "Run create_file?",
			kind: "edit",
			status: "pending",
			content: [{ newText: "hello\n", path: "/w/probe.txt", _meta: { kind: "add" }, type: "diff" }],
			locations: [{ path: "/w/probe.txt" }],
			rawInput: { file_path: "/w/probe.txt" },
		});
		assert.ok(mapped && mapped.kind === "tool_start");
		if (mapped.kind !== "tool_start") return;
		assert.equal(mapped.name, "create_file");
		assert.deepEqual(mapped.args, { file_path: "/w/probe.txt" });
		assert.deepEqual(mapped.diff, { path: "/w/probe.txt", newText: "hello\n" });
	});

	test("run-6 supersede echo is dropped, not rendered as a tool error", () => {
		// After the allow, the APPROVED id reports failed with this sentinel
		// while the real edit runs under a different id that succeeds.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "33eb71a04aae4d4c9b85081f20ab5169",
			status: "failed",
			rawOutput: "Tool call was approved but never executed.",
		});
		assert.equal(mapped, null);
	});

	test("run-6 completed update carries no diff (rawOutput only)", () => {
		// Verbatim: the completed update for the REAL call (supersede quirk -
		// different id than the approved one) has no content at all.
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "fake-session-0001:7",
			status: "completed",
			rawOutput: "Create probe.txt",
		});
		assert.deepEqual(mapped, { kind: "tool_done", toolCallId: "fake-session-0001:7", output: "Create probe.txt" });
	});

	test("tool_call_update failed maps to tool_error with the raw output as message", () => {
		// A GENUINE failure (not the RC01 approved-echo sentinel, which has its
		// own suppression test above).
		const mapped = mapUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "failed",
			rawOutput: "File not found: /x/nope.txt",
		});
		assert.deepEqual(mapped, {
			kind: "tool_error",
			toolCallId: "t1",
			message: "File not found: /x/nope.txt",
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

	test("cumulative resend flips only after a respectable accumulation", () => {
		const first = "a".repeat(32);
		const acc = new TextAccumulator();
		assert.equal(acc.append(first), first);
		// A cumulative sender repeats the full text: only the suffix emits.
		const full = `${first}\nmore`;
		assert.equal(acc.append(full), "\nmore");
		assert.equal(acc.text, full);
	});

	test("short-prefix extensions never flip (markdown opener regression)", () => {
		// Round-7: '**' followed by '**Contents:**' flipped the old guard and
		// corrupted every remaining frame. Short accumulations never flip; in
		// append mode the wire truth is the plain concatenation.
		const acc = new TextAccumulator();
		assert.equal(acc.append("**"), "**");
		assert.equal(acc.append("**Contents:**"), "**Contents:**");
		assert.equal(acc.append("\n"), "\n");
		assert.equal(acc.text, "****Contents:**\n");
	});

	test("unflips when a cumulative frame stops extending the accumulator", () => {
		const first = "a".repeat(40);
		const acc = new TextAccumulator();
		acc.append(first);
		assert.equal(acc.append(`${first} tail`), " tail");
		// Non-prefix frame = misflip evidence: back to deltas.
		assert.equal(acc.append("fresh"), "fresh");
		assert.equal(acc.text, `${first} tailfresh`);
	});

	test("non-extending chunk in cumulative mode is misflip evidence: unflip to deltas", () => {
		const base = "a".repeat(40);
		const acc = new TextAccumulator();
		acc.append(base);
		assert.equal(acc.append(`${base}def`), "def");
		// 'ab' cannot extend a 43-char accumulator: the flip was wrong.
		assert.equal(acc.append("ab"), "ab");
		assert.equal(acc.text, `${base}defab`);
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
