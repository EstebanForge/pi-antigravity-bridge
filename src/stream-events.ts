// agy stream-json NDJSON event types + parser.
//
// `agy --input-format stream-json --output-format stream-json` emits one JSON
// object per line on stdout: `init` (conversation binding), `step_update`
// (user_input / agent_response / checkpoint / tool steps), `result` (terminal).
// Shapes captured from live output and cross-checked against
// tianzuo/pi-antigravity lib/events.ts (MIT). Unknown event kinds parse as
// {kind:"unknown"} so a future agy release degrades instead of crashing the
// reader loop.

export interface AgyUsage {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
}

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR" | string;
export type AgyStepType = "user_input" | "checkpoint" | "agent_response" | "tool" | (string & {});

export interface AgyToolInfo {
	name?: string;
	parameters?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface AgyStepUpdate {
	step_index?: number;
	state?: AgyStepState;
	step_type?: AgyStepType;
	conversation_id?: string;
	tool_name?: string;
	tool_info?: AgyToolInfo;
	response_text?: string;
	/** Live agy (1.1.13+): agent_response deltas arrive here, not in response_text. */
	text_delta?: string;
	thought_text?: string;
	thinking_tokens?: number;
	thinking_signature?: string;
	duration_seconds?: number;
	error_message?: string;
	usage?: AgyUsage;
	[key: string]: unknown;
}

export interface AgyResult {
	status?: string;
	response?: string;
	error?: string;
	usage?: AgyUsage;
	conversation_id?: string;
	[key: string]: unknown;
}

export type ParsedAgyEvent =
	| { kind: "init"; conversationId?: string; usage?: AgyUsage }
	| { kind: "step"; step: AgyStepUpdate }
	| { kind: "result"; result: AgyResult }
	| { kind: "unknown"; raw: unknown };

/** Parse one stdout line. Never throws; bad JSON / non-objects become "unknown". */
export function parseAgyLine(line: string): ParsedAgyEvent {
	const trimmed = line.trim();
	if (!trimmed) return { kind: "unknown", raw: null };
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return { kind: "unknown", raw: trimmed.slice(0, 200) };
	}
	if (typeof obj !== "object" || obj === null) return { kind: "unknown", raw: obj };
	const rec = obj as Record<string, unknown>;
	if (rec.event === "init" && typeof rec.init === "object" && rec.init !== null) {
		const init = rec.init as Record<string, unknown>;
		return {
			kind: "init",
			conversationId:
				typeof init.conversation_id === "string" ? init.conversation_id : undefined,
			usage: isUsage(init.usage) ? init.usage : undefined,
		};
	}
	if (rec.event === "step_update" && typeof rec.step_update === "object" && rec.step_update !== null) {
		return { kind: "step", step: rec.step_update as AgyStepUpdate };
	}
	if (rec.event === "result" && typeof rec.result === "object" && rec.result !== null) {
		return { kind: "result", result: rec.result as AgyResult };
	}
	// Tolerate top-level shorthand: some agy builds put the payload at the root.
	if (rec.event === "init") {
		return {
			kind: "init",
			conversationId: typeof rec.conversation_id === "string" ? rec.conversation_id : undefined,
			usage: isUsage(rec.usage) ? (rec.usage as AgyUsage) : undefined,
		};
	}
	if (typeof rec.step_type === "string") return { kind: "step", step: rec as AgyStepUpdate };
	if (typeof rec.status === "string") return { kind: "result", result: rec as AgyResult };
	return { kind: "unknown", raw: obj };
}

function isUsage(u: unknown): u is AgyUsage {
	return typeof u === "object" && u !== null;
}

/** Map agy usage onto pi-ai's Usage (cost stays zero: subscription quota). */
export function toPiUsage(
	u: AgyUsage | undefined,
	piUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	if (!u) return;
	piUsage.input = u.input_tokens ?? piUsage.input;
	piUsage.output = u.output_tokens ?? piUsage.output;
	piUsage.cacheRead = u.cache_read_tokens ?? piUsage.cacheRead;
	piUsage.totalTokens = u.total_tokens ?? piUsage.input + piUsage.output;
}
