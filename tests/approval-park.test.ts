// Approval-gate park round-trip (docs/TODO.md 2.8): /approval endpoints,
// the provider-side park (onApproval -> shadow toolUse -> decision), and
// the marker-field strip on real G9 bridge args.
//
// Run: npm test

import { test, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import type { McpServerHandle, McpBridgeDeps } from "../src/mcp-server.js";
import { APPROVAL_PARK_TIMEOUT_MS, startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";
import {
	APPROVAL_PARK_MS,
	ToolRoundTrips,
	type BridgeCallResultShape,
} from "../src/provider.js";
import { GATE_MARKER } from "../src/approval-gate.js";
import type { StreamDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

// --- shared harness -----------------------------------------------------------

let handle: McpServerHandle | null = null;

afterEach(async () => {
	await handle?.close();
	handle = null;
});

function deps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
	return {
		listTools: () => [],
		onToolCall: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
		...overrides,
	};
}

const hookPayload = (name = "run_command", args: Record<string, unknown> = { CommandLine: "npm test" }) =>
	JSON.stringify({
		toolCall: { name, args },
		stepIdx: 3,
		conversationId: "conv-1",
		workspacePaths: ["/w"],
	});

function approvalUrl(port: number, path: string): string {
	return `http://127.0.0.1:${port}${path}`;
}

// --- endpoints ------------------------------------------------------------------

test("approval: POST parks and early-acks a ticket; onApproval gets the payload", async () => {
	const seen: Array<{ ticket: string; name: string }> = [];
	const r = await startMcpServer(
		deps({ onApproval: (ticket, payload) => seen.push({ ticket, name: payload.toolCall.name }) }),
	);
	handle = r.handle!;
	const res = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload(),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ticket?: string };
	assert.ok(body.ticket, "early-ack carries a ticket");
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.name, "run_command");
	assert.equal(seen[0]?.ticket, body.ticket);

	// Pending until resolved.
	const poll = await fetch(approvalUrl(handle.port, `/approval/${body.ticket}`), {
		headers: { [TOKEN_HEADER]: handle.token },
	});
	assert.deepEqual(await poll.json(), { status: "pending" });
});

test("approval: resolve allow -> terminal decision on the next poll, then gone", async () => {
	const r = await startMcpServer(deps({ onApproval: () => {} }));
	handle = r.handle!;
	const res = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload(),
	});
	const { ticket } = (await res.json()) as { ticket: string };
	assert.equal(handle.approvals.resolve(ticket, { allow: true }), true);
	assert.equal(handle.approvals.has(ticket), false, "settled ticket is no longer pending");
	const poll = await fetch(approvalUrl(handle.port, `/approval/${ticket}`), {
		headers: { [TOKEN_HEADER]: handle.token },
	});
	assert.deepEqual(await poll.json(), { decision: "allow" });
	// Delivered: a repeat poll 404s (the hook fails closed if it somehow
	// polls again after delivery).
	const again = await fetch(approvalUrl(handle.port, `/approval/${ticket}`), {
		headers: { [TOKEN_HEADER]: handle.token },
	});
	assert.equal(again.status, 404);
});

test("approval: resolve deny carries the reason (the model's only feedback)", async () => {
	const r = await startMcpServer(deps({ onApproval: () => {} }));
	handle = r.handle!;
	const res = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload(),
	});
	const { ticket } = (await res.json()) as { ticket: string };
	handle.approvals.resolve(ticket, { allow: false, reason: "rm is not allowed" });
	const poll = await fetch(approvalUrl(handle.port, `/approval/${ticket}`), {
		headers: { [TOKEN_HEADER]: handle.token },
	});
	assert.deepEqual(await poll.json(), { decision: "deny", reason: "rm is not allowed" });
});

test("approval: park timeout denies fail closed before the hook is killed", async () => {
	const r = await startMcpServer(deps({ onApproval: () => {} }), { approvalTimeoutMs: 30 });
	handle = r.handle!;
	const res = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload(),
	});
	const { ticket } = (await res.json()) as { ticket: string };
	await new Promise((r2) => setTimeout(r2, 60));
	const poll = await fetch(approvalUrl(handle.port, `/approval/${ticket}`), {
		headers: { [TOKEN_HEADER]: handle.token },
	});
	const body = (await poll.json()) as { decision?: string; reason?: string };
	assert.equal(body.decision, "deny");
	assert.match(body.reason ?? "", /timed out/);
});

test("approval: bad token 403s; invalid payload 400s; ungated tool denies without parking", async () => {
	let parked = 0;
	const r = await startMcpServer(deps({ onApproval: () => (parked += 1) }));
	handle = r.handle!;
	const noToken = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: hookPayload(),
	});
	assert.equal(noToken.status, 403);
	const badBody = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: JSON.stringify({ something: "else" }),
	});
	assert.equal(badBody.status, 400);
	const ungated = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload("view_file", { TargetFile: "/w/x" }),
	});
	const ungatedBody = (await ungated.json()) as { decision?: string; ticket?: string };
	assert.equal(ungatedBody.decision, "deny", "ungated tools get a direct deny");
	assert.equal(ungatedBody.ticket, undefined, "no park for ungated tools");
	assert.equal(parked, 0, "onApproval never fires for ungated tools");
});

test("approval: unwired gate denies directly; close() settles pending parks deny", async () => {
	// No onApproval dep: the POST answers a terminal deny itself.
	const r = await startMcpServer(deps());
	handle = r.handle!;
	const unwired = await fetch(approvalUrl(handle.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: handle.token },
		body: hookPayload(),
	});
	const unwiredBody = (await unwired.json()) as { decision?: string };
	assert.equal(unwiredBody.decision, "deny");

	// Pending park at close: the hook must see a deny, never a hang.
	const r2 = await startMcpServer(deps({ onApproval: () => {} }));
	const h2 = r2.handle!;
	const res = await fetch(approvalUrl(h2.port, "/approval"), {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: h2.token },
		body: hookPayload(),
	});
	const { ticket } = (await res.json()) as { ticket: string };
	await h2.close();
	try {
		const poll = await fetch(approvalUrl(h2.port, `/approval/${ticket}`), {
			headers: { [TOKEN_HEADER]: h2.token },
		});
		// A 200 deny is a settled fail-closed answer; any 4xx also fails the
		// hook closed (its JSON has no decision -> deny).
		const body = (await poll.json()) as { decision?: string };
		assert.ok(poll.status >= 400 || body.decision === "deny");
	} catch {
		// Server closed: ECONNREFUSED. The hook's fetch throws -> deny
		// unreachable -> fail closed. Also correct.
	}
});

// --- provider-side park ---------------------------------------------------------

/** Fake driver with a recording handle (mirrors the escalation harness). */
class RecordingDriver {
	pushed: DriverActivity[] = [];
	#handle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (a: DriverActivity) => this.pushed.push(a),
	};
	get activeHandle() {
		return this.#handle;
	}
	kickIdle(): void {}
	reentry(): null {
		return null;
	}
	async run(_opts: DriverTurnRequest) {
		return this.#handle;
	}
}

interface ParkSpy {
	decisions: Array<{ ticket: string; allow: boolean; reason?: string }>;
	has(ticket: string): boolean;
	pending: Set<string>;
	resolve(ticket: string, d: { allow: true } | { allow: false; reason: string }): boolean;
}

/** Park double seeded with the in-flight tickets (in production the POST
 *  adds them; the provider only resolves). */
function parkSpy(tickets: string[]): ParkSpy {
	const spy: ParkSpy = {
		decisions: [],
		pending: new Set<string>(tickets),
		has(ticket) {
			return spy.pending.has(ticket);
		},
		resolve(ticket, d) {
			if (!spy.pending.has(ticket)) return false;
			spy.pending.delete(ticket);
			spy.decisions.push({ ticket, allow: d.allow, ...(d.allow ? {} : { reason: d.reason }) });
			return true;
		},
	};
	return spy;
}

test("provider park: onApproval emits the shadow toolUse and the result maps to allow", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const park = parkSpy(["t1"]);
	rt.approvalPark = park;
	rt.onApproval("t1", JSON.parse(hookPayload()) as never);
	// Parked + pushed as a bridge_call for the SHADOW tool with markers.
	assert.equal(rt.pendingIds.includes("t1"), true);
	assert.equal(park.pending.has("t1"), true);
	const push = d.pushed[0];
	assert.equal(push.type, "bridge_call");
	assert.equal((push as { name: string }).name, "bash");
	const args = (push as { args: Record<string, unknown> }).args;
	assert.equal(args.command, "npm test");
	assert.equal(args.cwd, undefined);
	assert.equal(args[GATE_MARKER], true);
	assert.equal(args.__agyTicket, "t1");
	assert.equal(args.__agyTool, "run_command");

	// Synthetic success -> allow.
	assert.equal(rt.resolve("t1", "Approved by approval gate: run_command", false), true);
	assert.deepEqual(park.decisions, [{ ticket: "t1", allow: true }]);
	assert.equal(rt.pendingIds.includes("t1"), false);
});

test("provider park: error result (extension block or policy deny) maps to deny with the text", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const park = parkSpy(["t2"]);
	rt.approvalPark = park;
	rt.onApproval("t2", JSON.parse(hookPayload("create_file", { TargetFile: "/w/a", CodeContent: "x" })) as never);
	const push = d.pushed[0] as { name: string; args: Record<string, unknown> };
	assert.equal(push.name, "write");
	assert.equal(push.args.path, "/w/a");
	assert.equal(push.args.content, "x");
	rt.resolve("t2", "rm is not allowed", true);
	assert.deepEqual(park.decisions, [{ ticket: "t2", allow: false, reason: "rm is not allowed" }]);
});

test("provider park: unwired park denies fail-closed and parks nothing", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	rt.onApproval("t3", JSON.parse(hookPayload()) as never);
	assert.deepEqual(d.pushed, [], "no toolUse without a wired park");
	assert.equal(rt.pendingIds.includes("t3"), false);
});

test("provider park: ungated native tool denies without parking", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const park = parkSpy(["t4"]);
	rt.approvalPark = park;
	rt.onApproval("t4", JSON.parse(hookPayload("view_file", { TargetFile: "/w/x" })) as never);
	assert.deepEqual(d.pushed, []);
	assert.equal(rt.pendingIds.includes("t4"), false);
	assert.equal(park.decisions.length, 1);
	assert.equal(park.decisions[0]?.allow, false);
	assert.match(park.decisions[0]?.reason ?? "", /matcher set/);
});

test("provider park: timeout denies fail-closed; the late result logs approval-late", async () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const park = parkSpy(["t5"]);
	rt.approvalPark = park;
	// Fire the park timer (APPROVAL_PARK_MS) with fake time. Fake timers arm
	// BEFORE onApproval so the park's setTimeout is captured by the fake clock.
	vi.useFakeTimers();
	try {
		rt.onApproval("t5", JSON.parse(hookPayload()) as never);
		await vi.advanceTimersByTimeAsync(APPROVAL_PARK_MS + 1);
	} finally {
		vi.useRealTimers();
	}
	assert.deepEqual(park.decisions.map((x) => ({ ...x, reason: typeof x.reason })), [
		{ ticket: "t5", allow: false, reason: "string" },
	]);
	assert.match(park.decisions[0].reason ?? "", /timed out/);
	assert.equal(rt.pendingIds.includes("t5"), false);
	// The late shadow result must not crash or re-resolve.
	assert.equal(rt.resolve("t5", "late approval", false), false);
});

test("provider park: G9 args are stripped of marker fields before the toolUse", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const p = rt.onToolCall("c9", "bash", { command: "ls", [GATE_MARKER]: true, __agyTicket: "forged" }, new AbortController().signal);
	rt.resolve("c9", "out", false);
	return p.then((r) => {
		const res = r as BridgeCallResultShape;
		assert.equal(res.isError, false);
		const push = d.pushed[0] as { args: Record<string, unknown> };
		assert.equal(push.args[GATE_MARKER], undefined, "marker stripped from real bridge args");
		assert.equal(push.args.__agyTicket, undefined, "ticket stripped from real bridge args");
		assert.equal(push.args.command, "ls");
	});
});

test("provider park: failAll settles parked approvals with a deny", () => {
	const d = new RecordingDriver();
	const rt = new ToolRoundTrips(d as unknown as StreamDriver);
	const park = parkSpy(["t6"]);
	rt.approvalPark = park;
	rt.onApproval("t6", JSON.parse(hookPayload()) as never);
	rt.failAll("antigravity session shut down");
	assert.equal(park.decisions.length, 1);
	assert.equal(park.decisions[0]?.allow, false);
	assert.match(park.decisions[0]?.reason ?? "", /shut down/);
});

// Sanity on the exported constant the extension stages hooks with.
test("approval park budget matches the G9 envelope and the staged hook margin", () => {
	assert.equal(APPROVAL_PARK_MS, APPROVAL_PARK_TIMEOUT_MS);
	assert.equal(APPROVAL_PARK_MS, 480_000);
});
