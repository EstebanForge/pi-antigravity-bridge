// Core agy turn runner: spawn `agy -p`, poll its conversation DB for new steps,
// decode each, and emit structured events via a callback. Shared by the
// standalone CLI (scripts/run-agy.ts) and the pi provider (src/provider.ts).
//
// Streaming contract:
//   - agy writes steps to SQLite incrementally as it works.
//   - We poll the DB every POLL_INTERVAL_MS (250), decode new rows, emit.
//   - After agy exits, TRAILING_POLLS x 100ms catch late flushes.
//   - agy does NOT print the conversation id; we bind it by snapshot/diff
//     (see discovery.ts).
//
// agy runs its OWN closed tool loop (read/write/edit/exec against --add-dir).
// We cannot bridge those tools to pi. Tool steps surface as "tool" events so
// the UI can show "agy: editing foo.ts"  -  the edit itself already landed.

import { spawn, type ChildProcess } from "node:child_process";
import { bridgeMcpConfigDir, bridgeMcpConfigExists } from "./mcp-server.js";
import { ConversationPoller, type Step } from "./poller.js";
import {
	CONVERSATIONS_DIR,
	conversationDbPath,
	newConversationId,
	snapshotConversations,
} from "./discovery.js";
import { extractAgentText, extractToolCall, extractTitle } from "./protobuf.js";

// --- tuning -----------------------------------------------------------------

export const POLL_INTERVAL_MS = 250;
export const TRAILING_POLLS = 3;
export const TRAILING_POLL_MS = 100;
export const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;

// agy conversation ids are UUID DB-stems. First char must be alphanumeric so a
// leading-dash value can't misbind on agy's arg parser as the token after
// --conversation (flag injection). Hyphens allowed in the body (real UUIDs).
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

// --- events -----------------------------------------------------------------

export type AgyEvent =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; name: string; inputJson: string }
	| { kind: "title"; title: string };

// step_type values observed in real DBs. Tool steps share the same payload
// layout (field 5 -> toolCall), so we decode them uniformly. Unknown types
// are skipped (return null)  -  forward-compatible with future agy additions.
const TOOL_STEP_TYPES = new Set([5, 7, 8, 9, 17, 21, 33, 101, 132, 138]);

/** Map a raw step row to a decoded event, or null when nothing to emit.
 *  Pure: no I/O, no side effects. Exported for testing. */
export function decodeStep(step: Step): AgyEvent | null {
	if (step.stepType === 15) {
		const t = extractAgentText(step.payload);
		return t ? { kind: "text", text: t.text } : null;
	}
	if (step.stepType === 14) {
		// Thinking steps reuse the agentText layout (field 20.1) in observed DBs.
		const t = extractAgentText(step.payload);
		return t ? { kind: "thinking", text: t.text } : null;
	}
	if (step.stepType === 23) {
		const title = extractTitle(step.payload);
		return title ? { kind: "title", title } : null;
	}
	if (TOOL_STEP_TYPES.has(step.stepType)) {
		const tc = extractToolCall(step.payload);
		if (tc?.name) return { kind: "tool", name: tc.name, inputJson: tc.inputJson };
		return null;
	}
	return null;
}

// --- options + result -------------------------------------------------------

export interface AgyRunOptions {
	/** Workspace root agy operates in (passed as --add-dir). */
	cwd: string;
	/** Exact agy model string, e.g. "Gemini 3.6 Flash (Medium)". Caller
	 *  resolves aliases; the runner passes this through verbatim. */
	model?: string;
	/** agy execution mode. accept-edits = agy applies edits; plan = review-only. */
	mode?: "accept-edits" | "plan";
	/** Pass --dangerously-skip-permissions so commands don't hang on an
	 *  unanswerable y/n prompt in non-interactive `-p` mode. Default true.
	 *  Required for accept-edits to function; harmless under plan mode. */
	skipPermissions?: boolean;
	/** The prompt. Required. */
	prompt: string;
	/** Existing conversation id to resume. When set, agy reuses it (no snapshot). */
	conversationId?: string | null;
	/** Highest step idx already streamed in a prior turn (resume only). The
	 *  poller starts reading AFTER this idx so resumed turns don't replay
	 *  history. Default -1 (read everything). */
	baseStepIdx?: number;
	/** Hard cap on the run, in minutes. */
	timeoutMin?: number;
	/** Optional AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Conversations dir override (testing / isolation). */
	conversationsDir?: string;
	/** agy binary path. Defaults to AGY_BIN env or "agy". */
	binary?: string;
	/** Extra args appended (split from AGY_EXTRA_ARGS by the caller). */
	extraArgs?: string[];
}

export interface AgyRunResult {
	exitCode: number;
	conversationId: string | null;
	lastIdx: number;
	aborted: boolean;
	timedOut: boolean;
	stderr: string;
	durationMs: number;
}

// --- spawn helpers ----------------------------------------------------------

function resolveBinary(explicit?: string): string {
	return explicit || process.env.AGY_BIN || "agy";
}

function extraArgsFromEnv(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- the turn ---------------------------------------------------------------

/** Spawn agy and stream decoded events until it exits. Calls `onEvent` for
 *  every decoded step in order. Returns the run outcome (exit code, discovered
 *  conversation id, last step idx seen). Never throws on agy failure  - 
 *  surfaces non-zero exit / timeout / abort in the result. */
export async function runAgyTurn(
	opts: AgyRunOptions,
	onEvent: (event: AgyEvent) => void,
): Promise<AgyRunResult> {
	const start = Date.now();
	const dir = opts.conversationsDir || CONVERSATIONS_DIR;
	const mode = opts.mode ?? "accept-edits";
	const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
	const binary = resolveBinary(opts.binary);
	const extra = [...extraArgsFromEnv(), ...(opts.extraArgs ?? [])];

	const rawConvId = opts.conversationId ?? null;
	const isContinuation =
		typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
	const snapshot = isContinuation ? null : snapshotConversations(dir);
	let lastIdx = opts.baseStepIdx ?? -1;

	// Build argv. --add-dir first so agy binds the workspace before anything.
	const args = ["--add-dir", opts.cwd, ...extra];
	// When the MCP tool bridge is running, add its config dir so this agy
	// discovers pi's tools (memory, codegraph, search, ...). agy reads
	// .agents/mcp_config.json from --add-dir dirs. AskAntigravity does NOT pass
	// this dir, so its agy stays plain (no recursion).
	if (bridgeMcpConfigExists()) args.push("--add-dir", bridgeMcpConfigDir());
	if (opts.model) args.push("--model", opts.model);
	args.push("--mode", mode);
	// Without this, any run_command triggers an interactive permission prompt
	// that hangs forever in non-interactive print mode (no TTY to answer y/n).
	// accept-edits only auto-approves file writes, NOT commands. See PLAN.md.
	if (opts.skipPermissions !== false) args.push("--dangerously-skip-permissions");
	if (isContinuation && rawConvId) args.push("--conversation", rawConvId);
	args.push("--print-timeout", `${timeoutMin}m`);
	args.push("-p", opts.prompt);

	let stderr = "";
	let boundId = isContinuation ? rawConvId : null;

	// One poller per turn, lazily opened once we know the conversation id.
	let poller: ConversationPoller | null = null;
	// agy extends the step it is currently writing in place (same idx, growing
	// text). poll() returns only idx > lastIdx, so we re-read the last
	// text/thinking step each tick and emit the grown suffix as a delta.
	// flushStreamStep also runs BEFORE the loop so a step boundary landing
	// inside this tick doesn't drop the outgoing step's final in-place tail
	// (the loop may switch streamIdx to a new idx before we'd re-read).
	let streamIdx = -1;
	let streamKind: "text" | "thinking" | null = null;
	let streamEmitted = 0;
	const flushStreamStep = (): void => {
		if (streamIdx < 0 || !poller || !streamKind) return;
		const s = poller.readStepAt(streamIdx);
		if (!s) return;
		try {
			const t = extractAgentText(s.payload);
			if (t && t.text.length > streamEmitted) {
				onEvent({ kind: streamKind, text: t.text.slice(streamEmitted) });
				streamEmitted = t.text.length;
			}
		} catch {
			/* torn re-read; next poll retries */
		}
	};
	const pollOnce = (): boolean => {
		// Bind the conversation id on a fresh run (agy doesn't print it).
		// pid lets newConversationId disambiguate when a concurrent agy also
		// drops a new .db in the dir during our turn (see discovery.ts).
		if (!boundId && snapshot) {
			boundId = newConversationId(dir, snapshot, { pid: proc?.pid });
		}
		if (!boundId) return false;

		if (!poller) {
			poller = new ConversationPoller(conversationDbPath(boundId, dir), lastIdx);
		}
		if (!poller.isOpen && !poller.tryOpen()) return false;

		// Coalesce: one data_version check per tick gates BOTH the in-place
		// re-read (flushStreamStep -> readStepAt) and the new-row read. While
		// agy is thinking and hasn't committed, hasChanged() is false and we
		// skip both SELECTs, so no row read fires on an idle tick.
		if (!poller.hasChanged()) return false;

		// Catch the currently-tracked step's final in-place growth BEFORE the
		// loop may switch tracking to a new step.
		flushStreamStep();
		const steps = poller.readNewSteps();
		for (const step of steps) {
			// A torn read (agy mid-write) can throw RangeError out of the protobuf
			// walker. Drop that step rather than aborting the whole turn  -  the
			// row settles on the next poll. (agy-acp database.ts pattern, lifted
			// to the decode layer where the throw actually originates.)
			try {
				const event = decodeStep(step);
				if (event) {
					onEvent(event);
					if (event.kind === "text" || event.kind === "thinking") {
						streamIdx = step.idx;
						streamKind = event.kind;
						streamEmitted = event.text.length;
					}
				}
			} catch {
				/* drop undecodable step; lastIdx still advances past it */
			}
		}
		flushStreamStep();
		lastIdx = poller.lastIdx;
		return steps.length > 0;
	};

	const result: AgyRunResult = {
		exitCode: 0,
		conversationId: null,
		lastIdx: -1,
		aborted: false,
		timedOut: false,
		stderr: "",
		durationMs: 0,
	};

	let proc: ChildProcess | null = null;
	let settled = false;
	let timedOut = false;
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	const killTree = () => {
		try {
			if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
		} catch {
			/* process group already gone */
		}
		if (!sigkillTimer) {
			sigkillTimer = setTimeout(() => {
				try {
					if (proc?.pid) process.kill(-proc.pid, "SIGKILL");
				} catch {
					/* give up */
				}
			}, GRACE_AFTER_TIMEOUT_MS);
		}
	};

	const onAbort = () => killTree();

	try {
		await new Promise<void>((resolveP, rejectP) => {
			// detached: true so we can signal the whole process group. agy
			// spawns its own exec subprocesses in -p mode; a direct kill would
			// orphan those grandchildren.
			proc = spawn(binary, args, {
				cwd: opts.cwd,
				stdio: ["ignore", "ignore", "pipe"],
				shell: false,
				detached: true,
			});
			proc.stderr?.setEncoding("utf8");
			proc.stderr?.on("data", (d: string) => (stderr += d));

			// Drive the DB poll concurrently with the running process. THIS is the
			// streaming: without it, no event reaches the caller until agy exits,
			// defeating the whole point of the provider. Cleared in cleanup().
			const pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
			pollTimer.unref?.();

			const cleanup = () => {
				clearInterval(pollTimer);
				if (watchdog) clearTimeout(watchdog);
				if (sigkillTimer) clearTimeout(sigkillTimer);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			};

			// Enforce the timeout ourselves (agy's --print-timeout is advisory).
			watchdog = setTimeout(() => {
				timedOut = true;
				killTree();
			}, timeoutMin * 60_000);

			if (opts.signal) {
				if (opts.signal.aborted) killTree();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}

			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolveP();
				void code; // exit code read off proc below
			};

			proc.on("error", (err) => {
				cleanup();
				rejectP(err);
			});
			proc.on("close", finish);
			proc.on("exit", finish);
		});
	} catch (err) {
		// spawn ENOENT etc.  -  surface as a non-zero result, don't throw.
		stderr += err instanceof Error ? err.message : String(err);
	}

	// Capture abort state before the trailing-poll loop. On cancel we skip the
	// trailing polls (3 x 100ms) so the stream finalizes promptly with whatever
	// was already streamed, instead of stalling ~300ms after agy was killed.
	const wasAborted = !!opts.signal?.aborted;

	// Trailing polls: agy may flush a final step moments after exit. The
	// agy-acp pattern (3 x 100ms) catches these without adding noticeable latency.
	if (!wasAborted) {
		for (let i = 0; i < TRAILING_POLLS; i++) {
			pollOnce();
			await sleep(TRAILING_POLL_MS);
		}
	}

	// CFA note: poller/proc are assigned inside closures that TS can't track
	// through the await, so they narrow to `null` here. Casts break the
	// narrowing without lying about the runtime type.
	(poller as ConversationPoller | null)?.close();

	result.exitCode = (proc as ChildProcess | null)?.exitCode ?? (stderr ? 1 : 0);
	result.aborted = wasAborted;
	result.timedOut = timedOut;
	result.conversationId = boundId;
	result.lastIdx = lastIdx;
	result.stderr = stderr;
	result.durationMs = Date.now() - start;
	return result;
}
