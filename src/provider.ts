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
import { runAgyTurn, type AgyEvent, type AgyRunOptions } from "./runner.js";
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
interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	store: SessionStore;
	/** Override the agy turn runner (tests inject a scripted event source).
	 *  Defaults to the real runAgyTurn. */
	runAgyTurn?: typeof runAgyTurn;
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

/** Build the streamSimple closure. Captures the model catalog + session store
 *  resolved at extension load. */
export function createStreamSimple(
	deps: StreamSimpleDeps,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const { entries, store, runAgyTurn: runFn = runAgyTurn } = deps;

	return function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();
		// Fire the async turn; return the stream synchronously per pi's contract.
		void runTurn(stream, model, context, options, entries, store, runFn);
		return stream;
	};
}

async function runTurn(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	entries: AgyModelEntry[],
	store: SessionStore,
	runFn: typeof runAgyTurn,
): Promise<void> {
	const partial = newAssistant(model);
	const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };

	// Direct emit helpers. agy streams deltas that may not align to line
	// boundaries; pi's TUI renders partial lines fine, so we append and push
	// each delta straight through (no filtering, no buffering).
	const appendText = (delta: string): void => {
		ensureTextOpen(stream, blocks);
		textAt(partial, blocks.textIdx!).text += delta;
		stream.push({ type: "text_delta", contentIndex: blocks.textIdx!, delta, partial });
	};
	const appendThinking = (delta: string): void => {
		ensureThinkingOpen(stream, blocks);
		thinkingAt(partial, blocks.thinkingIdx!).thinking += delta;
		stream.push({ type: "thinking_delta", contentIndex: blocks.thinkingIdx!, delta, partial });
	};

	// Signal the turn has begun IMMEDIATELY. pi's native Working indicator is
	// driven by the stream's start event (isStreaming). Without this, agy's
	// initial thinking seconds (before it emits any step) show nothing and the
	// UI looks frozen. Lazy start (on first content) was the old behavior.
	ensureStarted(stream, blocks);

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const key = sessionKey(options, cwd);
	const existing = store.get(key);
	const messageCount = context.messages.length;

	const prompt = extractUserPrompt(context);
	if (!prompt) {
		finalize(stream, blocks, "error", "No user message to send to agy.");
		return;
	}

	// G1: inject a delta digest of pi-side context agy was not spawned for
	// (compaction summaries, other-provider turns). agy keeps its own history,
	// so this is a delta, not a replay. See docs/PI-BRIDGE-GAPS.md (G1).
	const watermark = existing?.lastMessageCount ?? 0;
	const digest = buildContextDigest(context.messages, watermark);
	const fullPrompt = digest ? `${DIGEST_PREAMBLE}\n\n${digest}\n\n---\n\n${prompt}` : prompt;

	// Resolve the pi model id to its catalog entry. On a miss, fall through to
	// the id itself  -  agy will likely reject, but the error reaches the user
	// instead of a silent no-op.
	const entry = entries.find((e) => e.id === model.id) ?? null;
	const agyModel = entry?.full ?? model.id;

	// Runtime config (mode, permissions). Loaded fresh each turn so /agy
	// toggles take effect immediately without a reload.
	const config = loadConfig();

	// Effort-driven bases always need --effort (a base slug is invalid on its
	// own); fixed models never get it (agy rejects --effort for them). For an
	// effort-driven base we clamp pi's level to the tiers agy offers it.
	const effort = entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined;

	const runOpts: AgyRunOptions = {
		cwd,
		model: agyModel,
		mode: config.mode,
		skipPermissions: config.skipPermissions,
		effort,
		prompt: fullPrompt,
		conversationId: existing?.conversationId ?? null,
		baseStepIdx: existing?.lastStepIdx ?? -1,
		timeoutMin: DEFAULT_TIMEOUT_MIN,
		signal: options?.signal,
	};

	// G8: per-turn diff context for agy's file edits (write_to_file et al.).
	// Turn-scoped so concurrent turns never share OLD-content caches.
	const diffCtx = new TurnDiffContext(createExecGitOps());

	const onEvent = (event: AgyEvent) => {
		switch (event.kind) {
			case "text":
				appendText(event.text);
				break;
			case "thinking":
				appendThinking(event.text);
				break;
			case "tool": {
				// G8: if agy wrote a file, surface a git-sourced diff; else the plain
				// tool label. Always shown (agy's own tool loop, surfaced for visibility).
				const edit = parseEditToolInput(event.inputJson ?? "");
				if (edit) {
					const absFile = path.isAbsolute(edit.file) ? edit.file : path.resolve(cwd, edit.file);
					const outcome = diffCtx.diffEdit(absFile, edit.content);
					const label = edit.description ?? path.basename(absFile);
					appendThinking(`[agy edit: ${label}]\n`);
					if (outcome.text) appendThinking(`${outcome.text}\n`);
				} else {
					appendThinking(`[agy tool: ${event.name}]\n`);
				}
				break;
			}
			case "title":
				// Conversation title metadata  -  not streamed to the user.
				break;
			case "warning":
				// Turn-end decoder diagnostics: visible hint, not response content.
				appendThinking(`${event.text}\n`);
				break;
		}
	};

	let result;
	try {
		result = await runFn(runOpts, onEvent);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		finalize(stream, blocks, "error", `agy failed to start: ${msg}`);
		return;
	}

	// Persist for the next turn (resume). Only bind when we actually discovered
	// an id  -  a discovery miss shouldn't clobber a prior good binding.
	// Persist for the next turn (resume). Only bind when we actually discovered
	// an id  -  a discovery miss shouldn't clobber a prior good binding. The
	// lastMessageCount watermark advances on a successful bind even if the turn
	// later aborted or timed out: the prompt (digest included) was handed to
	// agy at spawn, so its DB has seen that context. Guarding this on
	// exitCode===0 would re-inject stale deltas after retryable failures.
	if (result.conversationId) {
		store.set(key, {
			conversationId: result.conversationId,
			lastStepIdx: result.lastIdx,
			lastMessageCount: messageCount,
		});
	}

	if (result.aborted) {
		finalize(stream, blocks, "aborted", "Operation aborted");
		return;
	}
	if (result.timedOut) {
		const note = `agy exceeded the ${runOpts.timeoutMin}m timeout`;
		finalize(stream, blocks, "error", note);
		return;
	}
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || `agy exited with status ${result.exitCode}`;
		finalize(stream, blocks, "error", detail);
		return;
	}

	// Discovery miss: agy exited cleanly but we never bound a conversation id
	// this turn (ambiguous snapshot, DB not created in time, or a prior session
	// whose id failed CONV_ID_RE and silently fell through to fresh discovery).
	// Guard on whether we bound THIS turn, not on whether a prior session
	// existed - otherwise a corrupt existing entry re-opens the silent-empty-
	// success hole the first review closed.
	if (!result.conversationId) {
		const detail =
			"agy exited cleanly but its conversation database could not be bound. " +
			"The run may have partially applied edits with no visible output.";
		finalize(stream, blocks, "error", detail);
		return;
	}

	// Success. If no text ever streamed (agy did only tool work, or returned
	// empty), emit an empty text block so pi has a well-formed assistant turn.
	if (blocks.textIdx === null && blocks.thinkingIdx === null) {
		ensureTextOpen(stream, blocks);
	}
	finalize(stream, blocks, "stop");
}

/** Signal the start of the assistant turn exactly once. `start` is
 *  turn-level (analogous to Anthropic's message_start), not per-block  -  the
 *  per-block signals are text_start / thinking_start. */
function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
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
