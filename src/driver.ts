// Persistent agy stream-json driver.
//
// One long-lived `agy --input-format stream-json --output-format stream-json`
// process per provider instance. Turns are serialized through the driver
// queue; a turn that parks mid-flight (pi toolUse round-trip) keeps the agy
// process running and is re-entered via reentry() instead of spawning again.
//
// Recycle semantics: the child is killed and respawned when the next turn's
// process profile (model / effort / mode / cwd / conversation) drifts from the
// running one, mirroring tianzuo/pi-antigravity's driver. Stats and a bounded
// lifecycle log feed /agy doctor.
//
// The driver never talks to the MCP bridge directly: the provider owns the
// toolUse round-trips and injects bridge_call activities via
// handle.pushExternal(). This keeps the driver testable with a fake child.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseAgyLine } from "./stream-events.js";
import { bridgeMcpConfigDir, bridgeMcpConfigExists } from "./mcp-server.js";
import type {
	AgyUsage,
	DriverActivity,
	DriverProfile,
	DriverSnapshot,
	DriverState,
	DriverTurnRequest,
	TurnDriver,
	TurnHandle,
	TurnOutcome,
} from "./driver-types.js";

export type {
	DriverActivity,
	DriverProfile,
	DriverSnapshot,
	DriverState,
	DriverTurnRequest,
	TurnHandle,
	TurnOutcome,
} from "./driver-types.js";

const LIFECYCLE_LIMIT = 24;
const THINKING_TOKEN_FLOOR = 64;

interface ActiveTurn {
	id: string;
	request: DriverTurnRequest;
	/** Activities not yet pulled by a consumer. */
	buffer: DriverActivity[];
	/** Wake waiting next() callers. */
	wake: (() => void)[];
	closed: boolean;
	resolve: (o: TurnOutcome) => void;
	outcome: Promise<TurnOutcome>;
	overallTimer?: NodeJS.Timeout;
	idleTimer?: NodeJS.Timeout;
	onAbort?: () => void;
	response: string;
	usage?: AgyUsage;
	conversationId?: string;
	sawResult: boolean;
	/** Text-dedupe guard state (delta vs cumulative response_text). */
	cumulativeText: boolean | undefined;
	/** Open bridge parks. Each one suspends the stdout idle timer: agy is
	 *  blocked waiting on the MCP HTTP response and produces no output, so
	 *  inactivity is EXPECTED while parked. */
	parks: number;
}

function emit(turn: ActiveTurn, activity: DriverActivity): void {
	if (turn.closed) return;
	if (turn.wake.length > 0) turn.wake.shift()!();
	turn.buffer.push(activity);
}

async function nextActivity(turn: ActiveTurn): Promise<DriverActivity | null> {
	for (;;) {
		if (turn.buffer.length > 0) return turn.buffer.shift()!;
		if (turn.closed) return null;
		await new Promise<void>((r) => turn.wake.push(r));
	}
}

function makeHandle(turn: ActiveTurn): TurnHandle {
	return {
		id: turn.id,
		outcome: turn.outcome,
		next: () => nextActivity(turn),
		pushExternal: (activity) => {
			if (activity.type === "bridge_call") {
				turn.parks += 1;
				if (turn.idleTimer) {
					clearTimeout(turn.idleTimer);
					turn.idleTimer = undefined;
				}
			}
			emit(turn, activity);
		},
	};
}

function nowIso(): string {
	return new Date().toISOString().slice(11, 19);
}

/** True when `next` is a cumulative resend of `accumulated` (it repeats every
 *  byte already streamed) rather than a fresh delta. Exported for tests. */
export function isCumulativeResend(accumulated: string, next: string): boolean {
	// Nothing accumulated yet: no resend is possible (first chunk).
	return accumulated.length > 0 && next.length > accumulated.length && next.startsWith(accumulated);
}

/** Flip threshold for the same guard: short accumulations ("**", "#", "\n")
 *  are trivially extended by ordinary markdown deltas, and flipping on them
 *  corrupts every remaining frame of the turn. Require a respectable
 *  accumulation before believing a resend. Exported for tests. */
export const CUMULATIVE_FLIP_MIN_CHARS = 32;

/** Mode decision for the text-dedupe guard. Extracted for tests. */
export function shouldFlipToCumulative(accumulated: string, next: string): boolean {
	return accumulated.length >= CUMULATIVE_FLIP_MIN_CHARS && isCumulativeResend(accumulated, next);
}

export class AgyDriver implements TurnDriver {
	#state: DriverState = "idle";
	#child: ChildProcess | undefined;
	#generation = 0;
	#profile: DriverProfile | undefined;
	#boundConversation: string | undefined;
	#active: ActiveTurn | undefined;
	#queueTail: Promise<void> = Promise.resolve();
	#shutdown = false;
	#stderrTail = "";
	#lifecycle: string[] = [];
	#onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	#stats = {
		spawns: 0,
		turns: 0,
		reused: 0,
		recycles: 0,
		lastRecycleReason: undefined as string | undefined,
		recycleReasons: {} as Record<string, number>,
	};

	get state(): DriverState {
		return this.#state;
	}

	get activeHandle(): TurnHandle | null {
		return this.#active && !this.#active.closed ? makeHandle(this.#active) : null;
	}

	/** Called when a parked bridge call resolves or fails. Rearms the idle
	 *  timer once no parks remain. */
	kickIdle(): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		if (turn.parks > 0) turn.parks -= 1;
		if (turn.parks === 0 && !turn.idleTimer) {
			const idleMin = turn.request.inactivityMin ?? 5;
			turn.idleTimer = setTimeout(() => {
				if (turn.closed) return;
				this.#log(`stall:${turn.id}`);
				this.#killChild();
				this.#failTurn(turn, `agy stalled for ${idleMin}m with no output`);
			}, idleMin * 60_000);
		}
	}

	/** Hook: invoked with the outcome whenever a turn settles. The provider
	 *  uses it to fail round-trips parked against a dead turn. */
	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined) {
		this.#onTurnEnd = fn;
	}

	snapshot(): DriverSnapshot {
		return {
			state: this.#state,
			pid: this.#child?.pid,
			conversationId: this.#boundConversation,
			stats: { ...this.#stats, recycleReasons: { ...this.#stats.recycleReasons } },
			lifecycle: [...this.#lifecycle],
		};
	}

	/** Run one turn. Turn LIFETIMES are serialized: release fires only when
	 *  the dispatched turn settles, so a second run() can never overlap an
	 *  open turn (which would orphan the first). A turn parked on a pi toolUse
	 *  round-trip stays open; the continuation path uses reentry(), which does
	 *  not queue, so parking cannot deadlock the queue. */
	run(request: DriverTurnRequest): Promise<TurnHandle> {
		let release!: () => void;
		const prev = this.#queueTail;
		this.#queueTail = new Promise<void>((r) => (release = r));
		return prev
			.then(() => this.#runExclusive(request))
			.then((handle) => {
				void handle.outcome.catch(() => {}).then(() => release());
				return handle;
			})
			.catch((err) => {
				release();
				throw err;
			});
	}

	/** Re-attach to the active turn (pi toolUse continuation). */
	reentry(): TurnHandle | null {
		return this.activeHandle;
	}

	async #runExclusive(request: DriverTurnRequest): Promise<TurnHandle> {
		if (this.#shutdown) throw new Error("agy driver is shut down.");
		if (request.signal?.aborted) throw new Error("aborted before start");

		const cause = this.#recycleCause(request);
		if (cause) await this.close("recycle", cause);
		else if (this.#child) this.#stats.reused += 1;
		if (!this.#child) this.#start(request);

		const turn = this.#createTurn(request);
		this.#active = turn;
		this.#state = "running";
		this.#stats.turns += 1;
		this.#armTimers(turn);

		const line = `${JSON.stringify({
			event: "user",
			message: { role: "user", content: request.prompt },
		})}\n`;
		const stdin = this.#child?.stdin;
		try {
			if (!stdin) throw new Error("agy driver stdin unavailable");
			stdin.write(line);
		} catch (err) {
			this.#failTurn(
				turn,
				`failed to write to agy driver: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return makeHandle(turn);
	}

	#createTurn(request: DriverTurnRequest): ActiveTurn {
		let resolve!: (o: TurnOutcome) => void;
		const outcome = new Promise<TurnOutcome>((r) => (resolve = r));
		const turn: ActiveTurn = {
			id: randomUUID().slice(0, 8),
			request,
			buffer: [],
			wake: [],
			closed: false,
			resolve,
			outcome,
			response: "",
			sawResult: false,
			cumulativeText: undefined,
			parks: 0,
		};
		if (request.signal) {
			turn.onAbort = () => {
				if (turn.closed) return;
				this.#log(`abort:${turn.id}`);
				this.#killChild();
				this.#settle(turn, {
					conversationId: turn.conversationId,
					status: "ERROR",
					response: turn.response,
					error: "aborted",
					usage: turn.usage,
					finished: true,
					aborted: true,
				});
			};
			request.signal.addEventListener("abort", turn.onAbort, { once: true });
		}
		return turn;
	}

	#armTimers(turn: ActiveTurn): void {
		const totalMin = turn.request.timeoutMin ?? 10;
		turn.overallTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log(`timeout:${turn.id}`);
			this.#killChild();
			this.#failTurn(turn, `agy exceeded the ${totalMin}m turn timeout`);
		}, totalMin * 60_000);
		const idleMin = turn.request.inactivityMin ?? 5;
		turn.idleTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log(`stall:${turn.id}`);
			this.#killChild();
			this.#failTurn(turn, `agy stalled for ${idleMin}m with no output`);
		}, idleMin * 60_000);
	}

	#start(request: DriverTurnRequest): void {
		this.#state = "starting";
		this.#generation += 1;
		const generation = this.#generation;
		this.#profile = {
			cwd: request.cwd,
			model: request.model,
			effort: request.effort,
			mode: request.mode,
			skipPermissions: request.skipPermissions,
		};
		this.#boundConversation = request.conversationId ?? undefined;
		this.#stderrTail = "";

		const args: string[] = ["--add-dir", request.cwd];
		if (bridgeMcpConfigExists()) args.push("--add-dir", bridgeMcpConfigDir());
		args.push("--model", request.model);
		if (request.effort) args.push("--effort", request.effort);
		args.push("--mode", request.mode);
		if (request.skipPermissions) args.push("--dangerously-skip-permissions");
		if (request.conversationId) args.push("--conversation", request.conversationId);
		args.push(
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			// Skills and slash commands are bridged/owned by pi, not expanded by agy.
			"--disable-slash-commands",
		);

		const child = spawn("agy", args, {
			cwd: request.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.#child = child;
		this.#stats.spawns += 1;
		this.#log(`spawn:${child.pid ?? "?"}:${request.conversationId ? "resume" : "fresh"}`);
		this.#state = "ready";

		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			if (generation !== this.#generation) return;
			this.#onStdout(chunk);
		});
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-8192);
		});
		child.on("exit", (code) => {
			if (generation !== this.#generation) return;
			const turn = this.#active;
			this.#child = undefined;
			this.#state = "dead";
			this.#log(`exit:${code ?? "signal"}`);
			if (turn && !turn.closed) {
				if (turn.sawResult) {
					this.#settle(turn, {
						conversationId: turn.conversationId,
						status: turn.usage || turn.response ? "OK" : "UNKNOWN",
						response: turn.response,
						usage: turn.usage,
						finished: true,
						aborted: false,
					});
				} else {
					this.#failTurn(
						turn,
						this.#stderrTail.trim() || `agy exited with status ${code ?? "signal"}`,
					);
				}
			}
		});
		child.on("error", (err) => {
			if (generation !== this.#generation) return;
			const turn = this.#active;
			this.#child = undefined;
			this.#state = "dead";
			if (turn && !turn.closed) this.#failTurn(turn, `agy spawn failed: ${err.message}`);
		});
	}

	#onStdout(chunk: string): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		if (turn.idleTimer) turn.idleTimer.refresh();
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			this.#applyParsed(turn, parseAgyLine(line));
			if (turn.closed) return;
		}
	}

	#applyParsed(turn: ActiveTurn, parsed: ReturnType<typeof parseAgyLine>): void {
		switch (parsed.kind) {
			case "init": {
				if (parsed.conversationId) {
					turn.conversationId = parsed.conversationId;
					this.#boundConversation = parsed.conversationId;
				}
				if (parsed.usage) {
					turn.usage = parsed.usage;
					emit(turn, { type: "usage", usage: parsed.usage });
				}
				break;
			}
			case "step": {
				const s = parsed.step;
				if (s.conversation_id && !turn.conversationId) {
					turn.conversationId = s.conversation_id;
					this.#boundConversation = s.conversation_id;
				}
				if (s.usage) {
					turn.usage = s.usage;
					emit(turn, { type: "usage", usage: s.usage });
				}
				if (s.step_type === "agent_response") {
					const text =
						typeof s.text_delta === "string"
							? s.text_delta
							: typeof s.response_text === "string"
								? s.response_text
								: "";
					if (text) this.#appendAgentText(turn, text);
					if (typeof s.thinking_tokens === "number" && s.thinking_tokens >= THINKING_TOKEN_FLOOR) {
						emit(turn, { type: "thought", tokens: s.thinking_tokens });
					}
					break;
				}
				if (s.step_type === "tool") {
					const name = s.tool_name ?? s.tool_info?.name ?? "tool";
					const args =
						s.tool_info?.parameters && typeof s.tool_info.parameters === "object"
							? (s.tool_info.parameters as Record<string, unknown>)
							: {};
					if (s.state === "ACTIVE") {
						emit(turn, { type: "tool_start", stepId: s.step_index, name, args });
					} else if (s.state === "DONE") {
						emit(turn, {
							type: "tool_done",
							stepId: s.step_index,
							name,
							args,
							output: typeof s.response_text === "string" ? s.response_text : undefined,
							durationSeconds: s.duration_seconds,
						});
					} else if (s.state === "ERROR") {
						emit(turn, {
							type: "tool_error",
							stepId: s.step_index,
							name,
							message: s.error_message ?? "tool error",
						});
					}
				}
				// user_input / checkpoint: no provider-facing activity.
				break;
			}
			case "result": {
				turn.sawResult = true;
				const r = parsed.result;
				if (r.conversation_id) turn.conversationId = r.conversation_id;
				if (r.usage) turn.usage = r.usage;
				// agy reports SUCCESS on live stream-json runs (OK seen in older builds).
				const ok = r.status === "OK" || r.status === "SUCCESS";
				const status = ok ? "OK" : "ERROR";
				// Prefer the streamed accumulation, fall back to the result body.
				const response = turn.response || (typeof r.response === "string" ? r.response : "");
				turn.response = response;
				this.#settle(turn, {
					conversationId: turn.conversationId,
					status,
					response,
					error: status === "ERROR" ? (r.error ?? "agy reported an error") : undefined,
					usage: r.usage ?? turn.usage,
					finished: true,
					aborted: false,
				});
				break;
			}
			default:
				break;
		}
	}

	#appendAgentText(turn: ActiveTurn, text: string): void {
		// response_text is observed as a delta stream; guard against builds that
		// resend the full text. A cumulative sender's second chunk CONTAINS
		// everything accumulated so far as a prefix. Two guards against
		// misflips (round-7 review): short accumulations never flip, and a
		// cumulative frame that no longer extends the accumulator is evidence
		// of a misflip - fall back to append mode.
		if (turn.cumulativeText === undefined) {
			turn.cumulativeText = false;
		} else if (
			!turn.cumulativeText &&
			shouldFlipToCumulative(turn.response, text)
		) {
			turn.cumulativeText = true;
		}
		if (turn.cumulativeText) {
			if (!text.startsWith(turn.response)) {
				// Misflip evidence: back to deltas.
				turn.cumulativeText = false;
				turn.response += text;
				emit(turn, { type: "text", delta: text });
				return;
			}
			if (text.length > turn.response.length) {
				const delta = text.slice(turn.response.length);
				turn.response = text;
				emit(turn, { type: "text", delta });
			}
			return;
		}
		turn.response += text;
		emit(turn, { type: "text", delta: text });
	}

	#settle(turn: ActiveTurn, outcome: TurnOutcome): void {
		if (turn.closed) return;
		turn.closed = true;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		if (turn.onAbort && turn.request.signal) {
			turn.request.signal.removeEventListener("abort", turn.onAbort);
		}
		this.#active = undefined;
		this.#state = this.#child ? "ready" : "dead";
		for (const wake of turn.wake) wake();
		turn.wake = [];
		turn.resolve(outcome);
		try {
			this.#onTurnEnd?.(outcome);
		} catch {
			/* listener errors must not break settling */
		}
	}

	#failTurn(turn: ActiveTurn, message: string): void {
		this.#settle(turn, {
			conversationId: turn.conversationId,
			status: "ERROR",
			response: turn.response,
			error: message,
			usage: turn.usage,
			finished: true,
			aborted: false,
		});
	}

	#recycleCause(next: DriverTurnRequest): string | undefined {
		const cur = this.#profile;
		if (!cur) return undefined;
		if (cur.cwd !== next.cwd) return "cwd";
		if (cur.model !== next.model) return "model";
		if (cur.effort !== next.effort) return "effort";
		if (cur.mode !== next.mode) return "mode";
		if (cur.skipPermissions !== next.skipPermissions) return "permissions";
		if (!next.conversationId) return this.#boundConversation ? "conversation-reset" : undefined;
		return next.conversationId === this.#boundConversation ? undefined : "conversation";
	}

	async close(reason: "recycle" | "shutdown", cause?: string): Promise<void> {
		if (reason === "shutdown") this.#shutdown = true;
		const child = this.#child;
		if (!child) {
			this.#state = reason === "shutdown" ? "dead" : "idle";
			return;
		}
		if (reason === "recycle" && cause) {
			this.#stats.recycles += 1;
			this.#stats.lastRecycleReason = cause;
			this.#stats.recycleReasons[cause] = (this.#stats.recycleReasons[cause] ?? 0) + 1;
		}
		this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);
		const turn = this.#active;
		if (turn && !turn.closed) {
			this.#failTurn(turn, `agy driver ${reason}ed mid-turn${cause ? ` (${cause})` : ""}`);
		}
		this.#killChild();
		this.#state = reason === "shutdown" ? "dead" : "idle";
	}

	#killChild(): void {
		const child = this.#child;
		if (!child) return;
		this.#child = undefined;
		this.#generation += 1;
		try {
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
		} catch {
			/* already gone */
		}
		try {
			if (process.platform !== "win32" && child.pid) {
				process.kill(-child.pid, "SIGTERM");
				setTimeout(() => {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already dead */
					}
				}, 750);
			} else {
				child.kill("SIGTERM");
			}
		} catch {
			/* already dead */
		}
	}

	#log(msg: string): void {
		this.#lifecycle.push(`${nowIso()} ${msg}`);
		if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
	}
}
