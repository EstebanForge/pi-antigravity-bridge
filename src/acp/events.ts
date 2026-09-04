// ACP `session/update` payload → DriverActivity mapping + stopReason mapping.
//
// Pure functions, no I/O: unit-tested against the captured probe transcripts
// (probe-logs/acp-traffic-run5.jsonl, run6-restart-load-tools.jsonl).
//
// Shapes verified live against agy_acp_server 20260818_01_RC01:
//   session/update params = { sessionId, update: { sessionUpdate: <discriminator>, ... } }
//   - agent_message_chunk  { content: { type: "text", text } }         (pure deltas)
//   - agent_thought_chunk  { content: { type: "text", text } }          (thought TEXT)
//   - user_message_chunk   { content: { type: "text", text } }          (load replay only)
//   - tool_call            { toolCallId, title, kind, status, content?, locations?, rawInput? }
//   - tool_call_update     { toolCallId, status: completed|failed, rawOutput? }
//   - plan                 { entries: [...] }
//   - available_commands_update { availableCommands: [...] }
// Usage: ABSENT on RC01 (Gate B) — mapped defensively should a future build add it.

/** Map one `update` object to a driver-level event, or null when the update
 *  carries nothing the driver consumes (plan/commands are doctor/phase-2
 *  material; user_message_chunk is load replay and must never reach pi as
 *  live text). */
/** Native edit diff carried in tool_call content[] (run 6: edits arrive AS
 *  DIFFS: {type:"diff", path, newText, optional oldText}). The provider
 *  formats it in memory — no git subprocess needed on the ACP engine. */
export interface AcpEditDiff {
	path: string;
	oldText?: string;
	newText: string;
}

export type MappedUpdate =
	| { kind: "text"; delta: string }
	| { kind: "thought"; delta: string }
	| { kind: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown> }
	| { kind: "tool_done"; toolCallId: string; output?: string; diff?: AcpEditDiff }
	| { kind: "tool_error"; toolCallId: string; message: string }
	| { kind: "replay_user" }
	| null;

export function mapUpdate(update: unknown): MappedUpdate {
	if (typeof update !== "object" || update === null) return null;
	const u = update as Record<string, unknown>;
	const kind = u.sessionUpdate;
	if (typeof kind !== "string") return null;
	switch (kind) {
		case "agent_message_chunk":
			return { kind: "text", delta: chunkText(u.content) };
		case "agent_thought_chunk":
			return { kind: "thought", delta: chunkText(u.content) };
		case "user_message_chunk":
			return { kind: "replay_user" };
		case "tool_call": {
			const id = stringField(u.toolCallId);
			if (!id) return null;
			return {
				kind: "tool_start",
				toolCallId: id,
				name: metaToolName(u._meta) ?? toolName(u.title, u.kind),
				args: rawArguments(u.rawInput),
			};
		}
		case "tool_call_update": {
			const id = stringField(u.toolCallId);
			if (!id) return null;
			if (u.status === "failed") {
				return { kind: "tool_error", toolCallId: id, message: stringField(u.rawOutput) ?? "tool failed" };
			}
			if (u.status === "completed") {
				// content[] first (edits carry their diff there); rawOutput alone is
				// often just the server's display title, not the result (probe
				// 2026-09-03: completed MCP call, rawOutput "Call bridge_echo").
				const diff = contentDiff(u.content);
				return {
					kind: "tool_done",
					toolCallId: id,
					output: contentText(u.content) ?? stringField(u.rawOutput),
					...(diff ? { diff } : {}),
				};
			}
			return null; // in_progress or unknown status: nothing to render yet
		}
		default:
			// plan / available_commands_update / current_mode_update: consumed by
			// the driver snapshot / future phases, not mapped to activities.
			return null;
	}
}

/** MCP tools wrap their args in an `arguments` envelope
 *  ({arguments:{...}}); native tools carry them directly (probe 2026-09-03:
 *  bridge_echo rawInput {arguments:{text}}, edit_file rawInput {file_path}). */
function rawArguments(rawInput: unknown): Record<string, unknown> {
	const rec = recordField(rawInput);
	const args = rec.arguments;
	return typeof args === "object" && args !== null && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: rec;
}

/** Clean tool name for MCP tools: the title is "<server>_<tool>" (e.g.
 *  "pi-bridge_bridge_echo") and the real name hides in _meta.mcp.tool. */
function metaToolName(meta: unknown): string | undefined {
	const mcp = recordField(recordField(meta).mcp);
	const tool = mcp.tool;
	return typeof tool === "string" && tool.length > 0 ? tool : undefined;
}

/** First diff entry of a completed tool call: edits carry their native diff
 *  in content[] as {type:"diff", path, newText, optional oldText} (run 6). */
function contentDiff(content: unknown): AcpEditDiff | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const entry of content) {
		const e = recordField(entry);
		if (e.type !== "diff") continue;
		const path = stringField(e.path);
		const newText = stringField(e.newText);
		if (!path || newText === undefined) continue;
		const oldText = stringField(e.oldText);
		return oldText !== undefined ? { path, oldText, newText } : { path, newText };
	}
	return undefined;
}

/** Display text of a completed tool call. content[] entries wrap their
 *  payload ({type:"content", content:{type:"text", text}}); diff entries
 *  carry no text and are skipped. */
function contentText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const entry of content) {
		const inner = recordField(recordField(entry).content ?? entry);
		if (typeof inner.text === "string" && inner.text.length > 0) parts.push(inner.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Extract the text of a content block ({type:"text", text}). */
function chunkText(content: unknown): string {
	if (typeof content === "object" && content !== null) {
		const c = content as Record<string, unknown>;
		if (typeof c.text === "string") return c.text;
	}
	return "";
}

function stringField(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function recordField(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

/** Derive a tool name from the title ("Run create_file?", "Running edit_file")
 *  with the kind as fallback. Titles observed live: "Run create_file?",
 *  "Running edit_file", "Running view_file". */
export function toolName(title: unknown, kind: unknown): string {
	if (typeof title === "string") {
		const m = /(?:Run|Running)\s+([A-Za-z_][\w.]*)/i.exec(title);
		if (m) return m[1] as string;
	}
	return typeof kind === "string" && kind.length > 0 ? kind : "tool";
}

/** Map a `session/prompt` result stopReason to a TurnOutcome shape.
 *  Verified live: `end_turn`. Schema enumerates cancelled / max_tokens /
 *  max_turn_requests / refusal. `cancelled` is unreachable on RC01 (no
 *  cancel method) but mapped for the day upstream ships it. */
export function mapStopReason(stopReason: unknown): {
	status: "OK" | "ERROR";
	aborted: boolean;
	error?: string;
} {
	switch (stopReason) {
		case "end_turn":
			return { status: "OK", aborted: false };
		case "cancelled":
			return { status: "OK", aborted: true };
		case "max_tokens":
			return { status: "OK", aborted: false, error: "ACP: response hit the token cap" };
		case "refusal":
			return { status: "ERROR", aborted: false, error: "ACP: the model refused the request" };
		case "max_turn_requests":
			return { status: "ERROR", aborted: false, error: "ACP: turn exceeded the request limit" };
		default:
			return { status: "OK", aborted: false };
	}
}

/** Defensive accumulation with the cumulative-resend port. RC01 streams pure
 *  deltas (verified: mid-token splits across the run-5 stress streams), so on
 *  a compliant server the resend branch stays inert; it exists because the
 *  same backend's private protocol exhibited exactly this failure mode. */
export class TextAccumulator {
	#acc = "";
	#cumulative: boolean | undefined;

	/** Returns the delta to emit, or null when nothing new should be emitted. */
	append(delta: string): string | null {
		if (this.#cumulative === undefined) this.#cumulative = false;
		else if (!this.#cumulative && delta.length > this.#acc.length && delta.startsWith(this.#acc)) {
			this.#cumulative = true;
		}
		if (this.#cumulative) {
			if (delta.length <= this.#acc.length) return null;
			const emit = delta.slice(this.#acc.length);
			this.#acc = delta;
			return emit;
		}
		this.#acc += delta;
		return delta;
	}

	get text(): string {
		return this.#acc;
	}
}
