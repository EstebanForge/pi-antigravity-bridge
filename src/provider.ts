// The pi provider: streamSimple(model, context, options) -> AssistantMessageEventStream.
//
// For each turn pi calls streamSimple. We:
//   1. extract the latest user message (agy keeps its own history, so we send
//      only the new prompt, not pi's full transcript)
//   2. resolve the pi model id to the exact agy model string
//   3. look up the stored agy conversation id + last streamed step for this
//      pi session (resume) or start fresh
//   4. spawn agy via runAgyTurn, mapping decoded AgyEvents to pi stream events
//   5. persist the conversation id + final step idx for the next turn
//
// Event mapping (close-on-switch: at most one content block open at a time,
// matching pi-claude-bridge's lifecycle):
//   agy text     -> pi text block  (text_start / text_delta / text_end)
//   agy thinking -> pi thinking block
//   agy tool     -> pi thinking block, labelled "[agy tool: <name>]"
// We do NOT emit toolCall blocks: agy runs its OWN closed tool loop, so there
// is no toolUse stopReason and no tool-result delivery path back to pi.

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { AgyDriver, type DriverActivity, type TurnHandle } from "./driver.js";
import { toPiUsage } from "./stream-events.js";
import { mapAgyToolToNative } from "./native-tools.js";
import { type AgyEffort, type AgyModelEntry } from "./models.js";
import { SessionStore } from "./sessions.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { TurnDiffContext, createExecGitOps, parseEditToolInput } from "./diff-render.js";

const DEFAULT_TIMEOUT_MIN = 10;

/** Zero-usage helper. agy doesn't expose token counts; pi's cost math gets
 *  zeros (we're not billing through this provider). */
function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Extract the latest user message as a flat prompt string. agy maintains its
 *  own conversation history via --conversation, so we collapse pi's structured
 *  message to text. Returns null if the last message isn't a user message. */
function extractUserPrompt(context: Context): string | null {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user") return null;
	const content = last.content;
	if (typeof content === "string") return content;
	// Flatten text blocks; drop images (agy CLI prompt is text-only via -p).
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim() || null;
}

// --- G1: pi-side context digest --------------------------------------------------
//
// agy keeps its OWN conversation history (resumed via --conversation), so it
// already holds every turn it produced. What it lacks is pi-side context it was
// never spawned for: pi's compaction summaries and turns handled by OTHER
// providers (or pi's own tools). pi materializes all of that into
// context.messages every turn (verified: session-manager.js -> convertToLlm),
// so we build a DELTA digest from those messages and prepend it to the prompt.
// No pi patch, no new MCP tool. See docs/PI-BRIDGE-GAPS.md (G1).

const COMPACTION_MARKER = "compacted into the following summary";

const DIGEST_PREAMBLE =
	"[The following is context from the broader pi session that this Antigravity turn was not directly spawned for: compaction summaries and turns handled by other providers or pi's own tools. Your own prior turns are already in your conversation history. Use this for continuity only.]";

/** Flatten any message content shape (string or content-block array) to text.
 *  Drops images, thinking, and tool-call blocks. */
function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

/** A compaction summary arrives wrapped in pi's boilerplate prefix/suffix.
 *  Return just the summary body. */
function stripCompactionWrapping(t: string): string {
	const open = t.indexOf("<summary>");
	const close = t.lastIndexOf("</summary>");
	if (open >= 0 && close > open) return t.slice(open + "<summary>".length, close).trim();
	return t.trim();
}

export interface DigestOptions {
	/** Provider id whose assistant turns are already in agy's own DB and so
	 *  must be skipped to avoid double-counting. Default "antigravity". */
	ownProvider?: string;
	/** Soft cap on the digest body (0 = unbounded). Default 8000. */
	maxChars?: number;
}

/** Build a delta digest of pi-side context agy was not spawned for: the most
 *  recent compaction summary plus turns since the watermark that were not
 *  produced by this provider. Pure: no I/O. Exported for unit testing.
 *
 *  Delta, not replay: skip our own assistant turns (provider === ownProvider)
 *  and clamp the window to after any compaction (pre-compaction detail is
 *  either already in agy's DB or summarized by the injected summary).
 *
 *  Fidelity note: other-provider assistant turns contribute only their text
 *  blocks; tool-call and thinking blocks are dropped. The intent (which tool)
 *  is lost, but their results still surface separately as toolResult messages. */
export function buildContextDigest(
	messages: Message[],
	watermark: number,
	opts: DigestOptions = {},
): string {
	const own = opts.ownProvider ?? "antigravity";
	const maxChars = opts.maxChars ?? 8000;
	if (messages.length === 0) return "";

	let summaryPart: string | null = null;
	const deltaParts: string[] = [];

	// 1. Most-recent compaction summary (scan the whole list; it is never in
	//    agy's DB, so it is always safe and high-value to inject).
	let lastCompactionIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER)) {
			lastCompactionIdx = i;
			summaryPart = `[pi compaction summary]\n${stripCompactionWrapping(t)}`;
			break;
		}
	}

	// 2. Delta since the watermark, excluding the trailing current prompt.
	//    Clamp start to just after the compaction summary when one is present.
	let start = Math.max(0, Math.floor(watermark));
	if (lastCompactionIdx >= 0) start = Math.max(start, lastCompactionIdx + 1);
	const end = Math.max(0, messages.length - 1);
	for (let i = start; i < end; i++) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (m.provider === own) continue; // our own turn: already in agy's DB
			const t = blocksToText(m.content).trim();
			if (!t) continue;
			deltaParts.push(`[assistant turn from ${m.provider}]\n${t}`);
		} else if (m.role === "user") {
			const t = blocksToText(m.content);
			if (t.includes(COMPACTION_MARKER)) continue; // injected as summaryPart
			if (!t.trim()) continue;
			deltaParts.push(`[earlier user message]\n${t}`);
		} else if (m.role === "toolResult") {
			const t = blocksToText(m.content).trim();
			deltaParts.push(
				`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${t || "(no text output)"}`,
			);
		}
	}

	// Assemble. The compaction summary is always kept intact (it is the
	// canonical compressed history). The DELTA is truncated from the newest end
	// backward when over budget: recent context matters more for continuity
	// than older detail, so drop the oldest delta first. If even the newest
	// single item exceeds the budget, keep its tail slice.
	const SEP = "\n\n";
	const MARKER = "[truncated]";
	let delta = deltaParts.join(SEP);
	if (maxChars > 0) {
		const budget = Math.max(0, maxChars - (summaryPart ? summaryPart.length + SEP.length : 0));
		if (delta.length > budget) {
			const kept: string[] = [];
			let used = 0;
			for (let i = deltaParts.length - 1; i >= 0; i--) {
				const cost = deltaParts[i].length + (kept.length > 0 ? SEP.length : 0);
				if (used + cost > budget) break;
				kept.unshift(deltaParts[i]);
				used += cost;
			}
			if (kept.length > 0) {
				delta = `${MARKER}\n${kept.join(SEP)}`;
			} else {
				const room = Math.max(0, budget - MARKER.length - 1);
				delta = room > 0 ? `${MARKER}\n${deltaParts[deltaParts.length - 1].slice(-room)}` : "";
			}
		}
	}

	return [summaryPart, delta]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(SEP);
}

/** Build a fresh AssistantMessage shell for this turn. Mutated as blocks
 *  stream; passed as `partial` with every event. */
function newAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Session key: prefer pi's sessionId (stable per conversation), fall back to
 *  cwd so a single pi process still resumes correctly when sessionId is absent. */
function sessionKey(options: SimpleStreamOptions | undefined, cwd: string): string {
	const sid = (options as { sessionId?: string } | undefined)?.sessionId;
	return sid && sid.length > 0 ? `sid:${sid}` : `cwd:${cwd}`;
}

/** Track which content block is currently open so we close-on-switch.
 *  At most one of textIdx / thinkingIdx is non-null at a time. */
export interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	store: SessionStore;
	/** Persistent stream-json driver. Turns run on the driver and bridge
	 *  calls park as toolUse round-trips. Required with roundTrips. */
	driver?: AgyDriver;
	roundTrips?: ToolRoundTrips;
	/** Replay store for the display-only antigravity wrapper tool. Required
	 *  for native re-exec and wrapper cards; without it tool steps render as
	 *  thinking labels only. */
	replay?: WrapperReplay;
	/** Whether a pi tool is active in the session; native re-exec toolCalls
	 *  are only emitted for active builtins (else the wrapper). */
	nativeActive?: (name: string) => boolean;
}

/** pi thinking-effort order mirrors agy's, for clamping. */
const AGY_EFFORT_ORDER: readonly AgyEffort[] = ["low", "medium", "high"];

/** Map pi's thinking level onto one of the tiers `efforts` the base actually
 *  supports, clamping to the nearest available. agy rejects an effort tier a
 *  base doesn't list (e.g. medium on Pro), so we never emit one. A base slug is
 *  invalid without --effort, so when pi sends no level we default to the
 *  middle tier (or the highest available). */
export function toAgyEffort(
	reasoning: ThinkingLevel | undefined,
	efforts: readonly AgyEffort[],
): AgyEffort {
	let candidate: AgyEffort;
	switch (reasoning) {
		case "minimal":
		case "low":
			candidate = "low";
			break;
		case "medium":
			candidate = "medium";
			break;
		case "high":
		case "xhigh":
		case "max":
			candidate = "high";
			break;
		default:
			candidate = efforts[0] ?? "low";
	}
	if (efforts.includes(candidate)) return candidate;
	const i = AGY_EFFORT_ORDER.indexOf(candidate);
	for (let j = i; j < AGY_EFFORT_ORDER.length; j++) {
		if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
	}
	for (let j = i - 1; j >= 0; j--) {
		if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
	}
	return efforts[0] ?? "low";
}

// --- G9: no-patch pi-tool round-trips -----------------------------------------
//
// The MCP bridge's onToolCall parks the call here instead of executing it:
// the pending call is injected into the live driver turn as a bridge_call
// activity, the provider ends the pi assistant message with stopReason
// "toolUse" for the REAL pi tool, and pi's own loop executes it (native
// cards, permissions, hooks). The toolResult arrives in the NEXT stream
// call's context; resolve() then completes the parked MCP HTTP response and
// agy continues its still-running turn. No pi patch, no privileged API.

const BRIDGE_TIMEOUT_MS = 480_000;

export interface BridgeCallResultShape {
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
}

interface PendingRoundTrip {
	/** "bridge": parked MCP HTTP call; resolve() completes it.
	 *  "rt": native re-exec / wrapper round-trip; pi already executed, the
	 *  toolResult only confirms continuation, nothing remote to settle. */
	kind: "bridge" | "rt";
	name: string;
	resolve?: (r: BridgeCallResultShape) => void;
	reject?: (e: Error) => void;
	timer?: NodeJS.Timeout;
	onAbort?: () => void;
	signal?: AbortSignal;
}

/** Replay store for the display-only `antigravity` wrapper tool. The
 *  provider records each mutating agy step's output before emitting the
 *  toolUse; the wrapper tool's execute() returns it, so pi renders a real
 *  toolCall/toolResult pair without re-running anything. */
export class WrapperReplay {
	#map = new Map<string, string>();
	set(key: string, output: string): void {
		this.#map.set(key, output);
	}
	get(key: string): string | undefined {
		return this.#map.get(key);
	}
	/** Single-use consume: wrapper execute() takes the entry so stale outputs
	 *  cannot be enumerated by later callers and the map cannot grow unbounded. */
	take(key: string): string | undefined {
		const v = this.#map.get(key);
		this.#map.delete(key);
		return v;
	}
	get size(): number {
		return this.#map.size;
	}
}

export class ToolRoundTrips {
	#pending = new Map<string, PendingRoundTrip>();
	#driver: AgyDriver;
	#log: (s: string, d?: unknown) => void;

	constructor(driver: AgyDriver, log?: (s: string, d?: unknown) => void) {
		this.#driver = driver;
		this.#log = log ?? (() => {});
	}

	get pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	/** Fail all pending calls (driver recycle/shutdown path). */
	failAll(reason: string): void {
		for (const id of [...this.#pending.keys()]) this.#fail(id, reason);
	}

	#fail(callId: string, reason: string): void {
		const entry = this.#pending.get(callId);
		if (!entry) return;
		if (entry.kind === "rt") {
			// Nothing to reject, but the entry must not leak past turn death.
			this.#pending.delete(callId);
			return;
		}
		this.#pending.delete(callId);
		clearTimeout(entry.timer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		entry.reject!(new Error(reason));
		this.#driver.kickIdle();
		this.#log("round-trip-fail", { callId, name: entry.name, reason });
	}

	/** Park the MCP call: inject into the live agy turn; the promise settles
	 *  when pi's toolResult lands (resolve) or fail-closed (timeout/abort). */
	onToolCall = (
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<BridgeCallResultShape> => {
		const handle = this.#driver.activeHandle;
		if (!handle) {
			return Promise.reject(
				new Error(
					"no active antigravity turn; the pi tool bridge only works while an antigravity model is streaming",
				),
			);
		}
		return new Promise<BridgeCallResultShape>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#fail(callId, `pi tool round-trip timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`);
			}, BRIDGE_TIMEOUT_MS);
			const onAbort = () => this.#fail(callId, "agy disconnected before the tool result arrived");
			signal.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(callId, { kind: "bridge", name, resolve, reject, timer, onAbort, signal });
			handle.pushExternal({ type: "bridge_call", callId, name, args });
		});
	};

	/** Track a native re-exec or wrapper round-trip: pi executes the tool in
	 *  its own loop; the arriving toolResult only confirms continuation. */
	track(id: string, name: string): void {
		this.#pending.set(id, { kind: "rt", name });
	}

	/** Complete a parked call from a pi toolResult message. Returns false when
	 *  the id matches nothing pending. */
	resolve(toolCallId: string, text: string, isError: boolean): boolean {
		const entry = this.#pending.get(toolCallId);
		if (!entry) return false;
		this.#pending.delete(toolCallId);
		clearTimeout(entry.timer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		if (entry.kind === "rt") {
			this.#log("round-trip-rt-done", { callId: toolCallId, name: entry.name, isError });
			return true;
		}
		entry.resolve!({ content: [{ type: "text", text }], isError });
		this.#driver.kickIdle();
		this.#log("round-trip-resolved", { callId: toolCallId, name: entry.name, isError });
		return true;
	}
}

/** Extract toolResult messages whose toolCallId is still parked, as text. */
export function collectToolResults(
	messages: Message[],
	pendingIds: readonly string[],
): Array<{ toolCallId: string; text: string; isError: boolean }> {
	if (pendingIds.length === 0) return [];
	const pending = new Set(pendingIds);
	const out: Array<{ toolCallId: string; text: string; isError: boolean }> = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const id = (m as { toolCallId?: string }).toolCallId;
		if (!id || !pending.has(id)) continue;
		out.push({ toolCallId: id, text: blocksToText(m.content).trim(), isError: m.isError === true });
	}
	return out;
}

// --- stream-json engine -------------------------------------------------------

export interface DriverDeps {
	driver: AgyDriver;
	roundTrips: ToolRoundTrips;
	replay?: WrapperReplay;
	nativeActive?: (name: string) => boolean;
}

/** Map one DriverActivity onto the open pi stream. Returns "parked" when the
 *  activity ended the pi call with a toolUse round-trip. */
export interface ActivityFeatures {
	replay?: WrapperReplay;
	nativeActive?: (name: string) => boolean;
	roundTrips?: ToolRoundTrips;
}

/** Process-wide counter: round-trip ids must never repeat across turns in
 *  one session transcript. */
let RT_SEQ = 0;
function nextRtId(kind: "nat" | "wrap"): string {
	return `${kind}-${++RT_SEQ}`;
}

/** Emit a complete toolCall block and end the pi call with toolUse. */
function emitToolUse(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	id: string,
	name: string,
	args: Record<string, unknown>,
): void {
	const partial = blocks.partial;
	closeThinking(stream, blocks);
	closeText(stream, blocks);
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	partial.content.push(toolCall);
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	stream.end();
}

export function consumeActivity(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	activity: DriverActivity,
	diffCtx: TurnDiffContext,
	cwd: string,
	feats: ActivityFeatures,
): "parked" | "continue" {
	const partial = blocks.partial;
	switch (activity.type) {
		case "text":
			appendText(stream, blocks, activity.delta);
			return "continue";
		case "thought":
			// agy reports a token count only; no text body to render.
			return "continue";
		case "usage":
			toPiUsage(activity.usage, partial.usage);
			return "continue";
		case "tool_start":
			// Rendering happens on completion (output/diff available).
			return "continue";
		case "tool_done": {
			// G8: agy file edits surface a git-sourced diff in a thinking block.
			let inputJson: string | undefined;
			try {
				inputJson = JSON.stringify(activity.args);
			} catch {
				inputJson = undefined;
			}
			const edit = inputJson ? parseEditToolInput(inputJson) : null;
			if (edit) {
				const absFile = path.isAbsolute(edit.file) ? edit.file : path.resolve(cwd, edit.file);
				const outcome = diffCtx.diffEdit(absFile, edit.content);
				const label = edit.description ?? path.basename(absFile);
				appendThinking(stream, blocks, `[agy edit: ${label}]\n`);
				if (outcome.text) appendThinking(stream, blocks, `${outcome.text}\n`);
			} else {
				appendThinking(stream, blocks, `[agy tool: ${activity.name}]\n`);
			}
			// Native re-exec: read-only agy tools re-run as REAL pi builtins so
			// their cards render natively. Everything else replays through the
			// display-only wrapper tool. Both end the pi call with toolUse and
			// resume on the toolResult continuation. Without a replay store
			// (feature off) keep the label-only behavior.
			if (!feats.replay || !feats.roundTrips) return "continue";
			const mapped = mapAgyToolToNative(activity.name, activity.args);
			if (mapped && (!feats.nativeActive || feats.nativeActive(mapped.tool))) {
				const id = nextRtId("nat");
				feats.roundTrips.track(id, mapped.tool);
				// pi requires a reasoning argument on read/edit-class builtin calls
				// (validated against the wrapped schema); harmless where absent.
				emitToolUse(stream, blocks, id, mapped.tool, {
					reasoning: `re-exec of agy ${activity.name} for display`,
					...mapped.args,
				});
				return "parked";
			}
			{
				const id = nextRtId("wrap");
				feats.replay.set(id, activity.output ?? "(agy recorded no output)");
				feats.roundTrips.track(id, activity.name);
				emitToolUse(stream, blocks, id, "antigravity", { tool: activity.name, key: id });
				return "parked";
			}
		}
		case "tool_error":
			appendThinking(stream, blocks, `[agy tool: ${activity.name} failed: ${activity.message}]\n`);
			return "continue";
		case "bridge_call": {
			// Park the pi call: real tool name + args, toolUse stopReason. pi
			// executes; the toolResult returns on the next stream call.
			emitToolUse(stream, blocks, activity.callId, activity.name, activity.args);
			return "parked";
		}
	}
}

/** The stream-json engine: persistent driver + toolUse round-trips. */
async function runTurnDriver(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	entries: AgyModelEntry[],
	store: SessionStore,
	deps: DriverDeps,
): Promise<void> {
	const partial = newAssistant(model);
	const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const key = sessionKey(options, cwd);
	const existing = store.get(key);
	const messageCount = context.messages.length;
	const config = loadConfig();

	// Continuation: resolve parked round-trips from pi's toolResult messages,
	// then re-attach to the still-running agy turn. No new user event is sent:
	// agy receives the result via the bridge's MCP HTTP response.
	const results = collectToolResults(context.messages, deps.roundTrips.pendingIds);
	const isContinuation = results.length > 0;
	for (const r of results) deps.roundTrips.resolve(r.toolCallId, r.text, r.isError);

	let handle: TurnHandle;
	if (isContinuation) {
		const active = deps.driver.reentry();
		if (!active) {
			finalize(stream, blocks, "error", "tool result arrived but no antigravity turn is running");
			return;
		}
		handle = active;
	} else {
		const prompt = extractUserPrompt(context);
		if (!prompt) {
			finalize(stream, blocks, "error", "No user message to send to agy.");
			return;
		}
		const entry = entries.find((e) => e.id === model.id) ?? null;
		const agyModel = entry?.full ?? model.id;
		const effort = entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined;
		const watermark = existing?.lastMessageCount ?? 0;
		const digest = config.digest ? buildContextDigest(context.messages, watermark) : "";
		const fullPrompt = digest ? `${DIGEST_PREAMBLE}\n\n${digest}\n\n---\n\n${prompt}` : prompt;
		try {
			handle = await deps.driver.run({
				cwd,
				model: agyModel,
				effort,
				mode: config.mode,
				skipPermissions: config.skipPermissions,
				conversationId: existing?.conversationId ?? null,
				prompt: fullPrompt,
				signal: options?.signal,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			finalize(stream, blocks, "error", `agy failed to start: ${msg}`);
			return;
		}
	}

	ensureStarted(stream, blocks);
	const diffCtx = new TurnDiffContext(createExecGitOps());
	const feats: ActivityFeatures = {
		replay: deps.replay,
		nativeActive: deps.nativeActive,
		roundTrips: deps.roundTrips,
	};

	for (;;) {
		const activity = await handle.next();
		if (!activity) break;
		if (consumeActivity(stream, blocks, activity, diffCtx, cwd, feats) === "parked") return;
	}

	const outcome = await handle.outcome;
	if (outcome.conversationId) {
		store.set(key, {
			conversationId: outcome.conversationId,
			lastStepIdx: -1,
			lastMessageCount: messageCount,
		});
	}
	if (outcome.aborted) {
		finalize(stream, blocks, "aborted", "Operation aborted");
		return;
	}
	if (outcome.status === "ERROR") {
		finalize(stream, blocks, "error", outcome.error ?? "agy turn failed");
		return;
	}
	if (blocks.textIdx === null && blocks.thinkingIdx === null && outcome.response) {
		appendText(stream, blocks, outcome.response);
	}
	if (blocks.textIdx === null && blocks.thinkingIdx === null) {
		ensureTextOpen(stream, blocks);
	}
	finalize(stream, blocks, "stop");
}

/** Build the streamSimple closure. Captures the model catalog + session store
 *  resolved at extension load. When a driver is provided, turns run on the
 *  persistent stream-json engine (config.engine selects; legacy remains as
 *  fallback). */
export function createStreamSimple(
	deps: StreamSimpleDeps,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const { entries, store, driver, roundTrips } = deps;

	return function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();
		// Fire the async turn; return the stream synchronously per pi's contract.
		if (driver && roundTrips) {
			void runTurnDriver(stream, model, context, options, entries, store, {
				driver,
				roundTrips,
				replay: deps.replay,
				nativeActive: deps.nativeActive,
			});
		} else {
			// Miswired extension: no driver means no engine. Fail the turn visibly
			// instead of silently producing an empty assistant message.
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			finalize(stream, blocks, "error", "antigravity driver not configured");
		}
		return stream;
	};
}

/** Signal the start of the assistant turn exactly once. `start` is
 *  turn-level (analogous to Anthropic's message_start), not per-block  -  the
 *  per-block signals are text_start / thinking_start. */
function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

/** Append a text delta (opens the block on first use). Module-level so both
 *  engines share it. */
function appendText(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureTextOpen(stream, b);
	textAt(b.partial, b.textIdx!).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx!, delta, partial: b.partial });
}

/** Append a thinking delta (opens the block on first use). */
function appendThinking(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureThinkingOpen(stream, b);
	thinkingAt(b.partial, b.thinkingIdx!).thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: b.thinkingIdx!, delta, partial: b.partial });
}

/** Open the text block, closing the thinking block first if it's open. */
function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

/** Open the thinking block, closing the text block first if it's open. */
function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	stream.push({ type: "text_end", contentIndex: idx, content: textAt(b.partial, idx).text, partial: b.partial });
}

function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx === null) return;
	const idx = b.thinkingIdx;
	b.thinkingIdx = null;
	stream.push({ type: "thinking_end", contentIndex: idx, content: thinkingAt(b.partial, idx).thinking, partial: b.partial });
}

// Typed accessors: AssistantMessage.content is a discriminated union, but we
// always know which slot holds which block (we just pushed it). The cast is
// sound and keeps every mutation site free of scattered `as` expressions.
function textAt(p: AssistantMessage, idx: number): { type: "text"; text: string } {
	return p.content[idx] as { type: "text"; text: string };
}

function thinkingAt(p: AssistantMessage, idx: number): { type: "thinking"; thinking: string } {
	return p.content[idx] as { type: "thinking"; thinking: string };
}

/** Close any open block and push the terminal event. */
function finalize(
	stream: AssistantMessageEventStream,
	b: BlockState,
	reason: "stop" | "error" | "aborted",
	message?: string,
): void {
	closeText(stream, b);
	closeThinking(stream, b);
	if (reason === "stop") {
		b.partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: b.partial });
	} else {
		b.partial.stopReason = reason;
		if (message) b.partial.errorMessage = message;
		stream.push({ type: "error", reason, error: b.partial });
	}
	stream.end();
}
