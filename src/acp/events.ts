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
export type MappedUpdate =
	| { kind: "text"; delta: string }
	| { kind: "thought"; delta: string }
	| { kind: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown> }
	| { kind: "tool_done"; toolCallId: string; output?: string }
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
				name: toolName(u.title, u.kind),
				args: recordField(u.rawInput),
			};
		}
		case "tool_call_update": {
			const id = stringField(u.toolCallId);
			if (!id) return null;
			if (u.status === "failed") {
				return { kind: "tool_error", toolCallId: id, message: stringField(u.rawOutput) ?? "tool failed" };
			}
			if (u.status === "completed") {
				return { kind: "tool_done", toolCallId: id, output: stringField(u.rawOutput) };
			}
			return null; // in_progress or unknown status: nothing to render yet
		}
		default:
			// plan / available_commands_update / current_mode_update: consumed by
			// the driver snapshot / future phases, not mapped to activities.
			return null;
	}
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
