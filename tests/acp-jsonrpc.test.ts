// Unit tests for the JSON-RPC framing/correlation layer. Transport-free: the
// "wire" is a captured array of sent frames; incoming bytes are fed directly.

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { JsonRpcResponseError, JsonRpcSession } from "../src/acp/jsonrpc.js";

function makeSession(handlers: Partial<ConstructorParameters<typeof JsonRpcSession>[0]> = {}) {
	const sent: unknown[] = [];
	const session = new JsonRpcSession({
		send: (frame) => sent.push(JSON.parse(frame)),
		...handlers,
	});
	return { session, sent };
}

describe("acp/jsonrpc", () => {
	test("request correlates the response by id", async () => {
		const { session, sent } = makeSession();
		const p = session.request("session/new", { cwd: "/x" });
		const frame = sent[0] as { id: number; method: string; params: unknown };
		assert.equal(frame.method, "session/new");
		assert.deepEqual(frame.params, { cwd: "/x" });
		session.feed(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s1" } }) + "\n");
		assert.deepEqual(await p, { sessionId: "s1" });
	});

	test("error results reject with JsonRpcResponseError carrying code + data", async () => {
		const { session, sent } = makeSession();
		const p = session.request("session/cancel", { sessionId: "s" });
		const id = (sent[0] as { id: number }).id;
		session.feed(
			JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found", data: { method: "session/cancel" } } }) +
				"\n",
		);
		await assert.rejects(p, (err: unknown) => {
			assert.ok(err instanceof JsonRpcResponseError);
			assert.equal(err.code, -32601);
			assert.deepEqual(err.data, { method: "session/cancel" });
			return true;
		});
	});

	test("server requests are answered through the handler with the same id", async () => {
		const { session, sent } = makeSession({
			onRequest: async (method) => {
				assert.equal(method, "session/request_permission");
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
		});
		session.feed(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "session/request_permission",
				params: { options: [{ optionId: "allow", kind: "allow_once" }] },
			}) + "\n",
		);
		await new Promise((r) => setImmediate(r));
		const reply = sent[0] as { id: number; result: { outcome: { optionId: string } } };
		assert.equal(reply.id, 7);
		assert.equal(reply.result.outcome.optionId, "allow");
	});

	test("handler throw answers with a JSON-RPC error", async () => {
		const { session, sent } = makeSession({
			onRequest: async () => {
				throw new Error("client capability not enabled: terminal/create");
			},
		});
		session.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "terminal/create", params: {} }) + "\n");
		await new Promise((r) => setImmediate(r));
		const reply = sent[0] as { id: number; error: { code: number; message: string } };
		assert.equal(reply.error.code, -32000);
		assert.match(reply.error.message, /capability not enabled/);
	});

	test("notifications route to onNotification", async () => {
		const seen: Array<{ method: string; params: unknown }> = [];
		const { session } = makeSession({ onNotification: (m, p) => seen.push({ method: m, params: p }) });
		session.feed(JSON.stringify({ jsonrpc: "2.0", method: "auth_required", params: { reason: "x" } }) + "\n");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.method, "auth_required");
	});

	test("partial lines split across feed calls are buffered, not dropped", async () => {
		const { session, sent } = makeSession();
		const p = session.request("session/ping", {});
		const id = (sent[0] as { id: number }).id;
		// The response frame arrives split across two stdio chunks.
		const full = JSON.stringify({ jsonrpc: "2.0", id, result: { pong: true } });
		session.feed(full.slice(0, 17));
		session.feed(full.slice(17) + "\n");
		assert.deepEqual(await p, { pong: true });
	});

	test("multiple complete lines in one chunk all parse", async () => {
		const seen: string[] = [];
		const { session } = makeSession({ onNotification: (m) => seen.push(m) });
		session.feed(
			JSON.stringify({ jsonrpc: "2.0", method: "auth_required" }) +
				"\n" +
				JSON.stringify({ jsonrpc: "2.0", method: "auth_required" }) +
				"\n",
		);
		assert.equal(seen.length, 2);
	});

	test("malformed lines are counted, never fatal", async () => {
		const { session } = makeSession();
		session.feed("this is not json\n");
		session.feed("\n");
		session.feed(JSON.stringify({ jsonrpc: "2.0", method: "auth_required" }));
		assert.equal(session.parseErrors, 1);
	});

	test("request timeout fires and removes the pending entry", async () => {
		const { session } = makeSession({ defaultTimeoutMs: 30 });
		await assert.rejects(session.request("session/prompt", {}), /timed out/);
		assert.equal(session.pendingCount, 0);
	});

	test("abortAll rejects every pending request and blocks new ones", async () => {
		const { session } = makeSession();
		const p = session.request("session/prompt", {});
		session.abortAll("connection killed");
		await assert.rejects(p, /connection killed/);
		await assert.rejects(session.request("session/prompt", {}), /aborted/);
	});

	test("late responses to aborted requests are dropped, not crashes", () => {
		const { session } = makeSession();
		const p = session.request("session/prompt", {});
		session.abortAll("killed");
		// A response arriving after the teardown must not throw synchronously.
		session.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
		assert.equal(session.pendingCount, 0);
		void p.catch(() => {});
	});
});
