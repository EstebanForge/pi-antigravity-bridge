// AcpDriver: the ACP turn engine. Implements the same TurnDriver surface as
// the legacy stream-json driver (see src/driver-types.ts) so provider.ts and
// the G9 round-trip store work unchanged.
//
// Engine differences vs legacy, all verified live (docs/ACP-PROTOCOL-REFERENCE.md):
//   - no process recycle on profile drift: one server process, sessions
//     selected per turn via session/new / session/load
//   - model/effort via session/set_config_option (configId "model", FULL slug
//     with the effort tier baked in); mode via configId "mode"
//   - config does NOT persist across server restarts: re-applied every turn
//   - session/load replays history as full-text notification pairs BEFORE its
//     response; the connection suppresses updates while loading
//   - session/cancel is unimplemented on RC01 (-32601): abort = abortAll()
//     teardown + kill, then session/load on the next turn. The method is
//     probed once per connection; when upstream ships it, abort goes graceful
//   - overall-timer pause uses remaining-budget semantics on G9 parks (never a
//     fresh cap); every park carries its own timeout (BRIDGE_TIMEOUT_MS)
//   - single `auto` permission policy: request_permission answered
//     in-connection (plan §9.3); no provider involvement

import { randomUUID } from "node:crypto";
import { AcpConnection, resolveAcpBinary, type AcpMcpServer } from "./connection.js";
import { mapStopReason, mapUpdate, TextAccumulator, type AcpEditDiff } from "./events.js";
import type {
	DriverActivity,
	DriverSnapshot,
	DriverState,
	DriverTurnRequest,
	TurnDriver,
	TurnHandle,
	TurnOutcome,
} from "../driver-types.js";

const LIFECYCLE_LIMIT = 24;

export interface AcpDriverOptions {
	/** Config acp.bin value (may be empty). Env AGY_ACP_BIN wins. A function
	 *  is resolved per connection: setup can install the binary and update
	 *  config mid-session, and the next turn picks it up without a restart. */
	bin: string | (() => string);
	/** Extra argv for the binary (tests: node + fake-server script). */
	binArgs?: string[];
	extraEnv?: Record<string, string>;
	/** Record file for BROWSER-captured OAuth URLs; passed to the connection,
	 *  which logs "auth-url" when the server tries to open a login. */
	authUrlFile?: string;
	/** Bridge registration for session/new AND session/load. */
	mcpServers?: () => AcpMcpServer[];
	log?: (msg: string, data?: unknown) => void;
}

interface ActiveTurn {
	id: string;
	request: DriverTurnRequest;
	sessionId: string;
	buffer: DriverActivity[];
	wake: (() => void)[];
	closed: boolean;
	resolve: (o: TurnOutcome) => void;
	outcome: Promise<TurnOutcome>;
	response: TextAccumulator;
	sawResult: boolean;
	/** True once the prompt RPC was issued. Abort before this point has
	 *  nothing to cancel: probing would risk a success-as-noop answer from a
	 *  future cancel-capable server stranding the turn in the safety-net
	 *  wait, so the driver tears down instead. */
	promptStarted: boolean;
	aborted: boolean;
	abortedBy: "signal" | "timer" | null;
	parks: number;
	/** Wall-clock deadline of the overall timer; null while paused. */
	overallDeadline: number | null;
	overallRemainingMs: number | null;
	overallTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** toolCallId → tool name + args + optional native diff (diff rides on
	 *  the pending tool_call frame; updates don't repeat it). */
	toolCalls: Map<string, { name: string; args: Record<string, unknown>; diff?: AcpEditDiff }>;
	/** Last pending native tool seen. The supersede quirk (run 6, finding 7)
	 *  means the executing call can arrive under a DIFFERENT id than the
	 *  approved one; unknown-id updates adopt this so the diff and name are
	 *  not lost. */
	lastNativeTool?: { name: string; args: Record<string, unknown>; diff?: AcpEditDiff };
}

/** Recombine the provider's (base slug, effort) into the FULL ACP model slug.
 *  Fixed families (no effort) pass through unchanged. Verified against the
 *  run-5 catalog: session/set_config_option wants "gemini-3.8-flash-low"-style
 *  full slugs. */
export function acpModelSlug(model: string, effort?: string): string {
	if (!effort) return model;
	if (/(?:^|-)(?:high|medium|low)$/.test(model)) return model;
	return `${model}-${effort}`;
}

/** Map our config knobs onto ACP session modes. skipPermissions=false also
 *  fail-closes the in-connection permission handler (reject options), so the
 *  modes keep their server-side meaning. Known gap: the CLI's `--mode plan`
 *  has no ACP equivalent (review 4, finding 4) — plan + acp is refused at the
 *  command level and fails the turn visibly. */
export function acpMode(mode: string, skipPermissions: boolean): string {
	if (skipPermissions) return "yolo";
	return mode === "plan" ? "default" : "auto_edit";
}

export class AcpDriver implements TurnDriver {
	#opts: AcpDriverOptions;
	#state: DriverState = "idle";
	#conn: AcpConnection | undefined;
	#generation = 0;
	#active: ActiveTurn | undefined;
	#queueTail: Promise<void> = Promise.resolve();
	#shutdown = false;
	#lifecycle: string[] = [];
	#onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	#stats = {
		spawns: 0,
		turns: 0,
		sessionsCreated: 0,
		sessionsLoaded: 0,
		kills: 0,
	};
	#serverVersion: string | undefined;
	#lastSessionId: string | undefined;
	#lastCancelSupported: boolean | null = null;
	#agentInfo: { name?: string; title?: string } | undefined;

	constructor(opts: AcpDriverOptions) {
		this.#opts = opts;
		this.#log("driver-created", { bin: typeof opts.bin === "function" ? "(resolved per turn)" : resolveAcpBinary(opts.bin) });
	}

	get state(): DriverState {
		return this.#state;
	}

	get activeHandle(): TurnHandle | null {
		const t = this.#active;
		return t && !t.closed ? this.#makeHandle(t) : null;
	}

	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined) {
		this.#onTurnEnd = fn;
	}

	/** Inject a synthetic activity into the live turn (bridge inbox). Parks the
	 *  turn: suspends the idle timer and pauses the overall deadline. */
	pushExternal(activity: DriverActivity): void {
		const t = this.#active;
		if (!t || t.closed) return;
		if (activity.type === "bridge_call") {
			t.parks += 1;
			this.#clearIdle(t);
			this.#pauseOverall(t);
		}
		this.#emit(t, activity);
	}

	kickIdle(): void {
		const t = this.#active;
		if (!t || t.closed) return;
		if (t.parks > 0) t.parks -= 1;
		if (t.parks === 0) {
			this.#armIdle(t);
			this.#resumeOverall(t);
			this.#log("unparked");
		}
	}

	/** Turns are serialized; a parked turn stays open and the continuation
	 *  path uses reentry() (same contract as the legacy driver). */
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

	reentry(): TurnHandle | null {
		return this.activeHandle;
	}

	#runExclusive(request: DriverTurnRequest): Promise<TurnHandle> {
		if (this.#shutdown) return Promise.reject(new Error("ACP driver is shut down."));
		if (request.signal?.aborted) return Promise.reject(new Error("aborted before start"));

		const turn = this.#createTurn(request);
		this.#active = turn;
		this.#state = "running";
		this.#stats.turns += 1;
		this.#log("turn-start", {
			model: request.model,
			effort: request.effort,
			mode: request.mode,
			conversation: request.conversationId ?? null,
			images: request.images?.length ?? 0,
			contextBlock: request.contextBlock ? true : undefined,
		});

		// Abort wiring first: a kill during session setup must still settle the
		// turn (Gate D teardown applies from the first request).
		if (request.signal) {
			const onAbort = () => void this.#abortTurn(turn);
			if (request.signal.aborted) {
				onAbort();
			} else {
				request.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Execute asynchronously: the handle returns as soon as the prompt is
		// dispatched, and activities stream through next() (legacy contract).
		void this.#executeTurn(turn).catch((err: unknown) => {
			this.#failTurn(turn, `ACP turn failed: ${describe(err)}`);
		});
		return Promise.resolve(this.#makeHandle(turn));
	}

	async #executeTurn(turn: ActiveTurn): Promise<void> {
		const request = turn.request;
		const conn = await this.#ensureConnection(request);

		// Session: load (resume) or create. Load failures fall back to a fresh
		// session — a missing conversation must not fail the turn (9.4).
		try {
			if (request.conversationId) {
				this.#log("session-load", { sessionId: request.conversationId });
				this.#stats.sessionsLoaded += 1;
				await conn.loadSession(request.conversationId, request.cwd);
				turn.sessionId = request.conversationId;
			} else {
				const created = await conn.newSession(request.cwd);
				turn.sessionId = created.sessionId;
				this.#stats.sessionsCreated += 1;
				this.#log("session-new", { sessionId: created.sessionId });
			}
		} catch (err) {
			if (turn.aborted) {
				this.#settle(turn, {
					conversationId: turn.sessionId,
					status: "OK",
					response: turn.response.text,
					finished: true,
					aborted: true,
				});
				return;
			}
			if (request.conversationId) {
				this.#log("session-load-failed-creating-fresh", {
					sessionId: request.conversationId,
					message: err instanceof Error ? err.message : String(err),
				});
				try {
					const created = await conn.newSession(request.cwd);
					turn.sessionId = created.sessionId;
					this.#stats.sessionsCreated += 1;
				} catch (err2) {
					this.#failTurn(turn, `ACP session failed: ${describe(err2)}`);
					return;
				}
			} else {
				this.#failTurn(turn, `ACP session failed: ${describe(err)}`);
				return;
			}
		}
		if (turn.closed) return;

		// Config: model + mode. Model failure fails the turn (wrong-model turns
		// are a parity break); mode failure is best-effort (auto policy makes
		// the modes converge anyway).
		try {
			await conn.setConfigOption(turn.sessionId, "model", acpModelSlug(request.model, request.effort));
		} catch (err) {
			this.#failTurn(turn, `ACP model selection failed: ${describe(err)}`);
			return;
		}
		try {
			await conn.setConfigOption(turn.sessionId, "mode", acpMode(request.mode, request.skipPermissions));
		} catch (err) {
			this.#log("mode-apply-failed", { message: describe(err) });
		}
		if (turn.closed) return;

		// Timers: overall (turn deadline, pause-aware) + idle (inactivity).
		this.#armOverall(turn);
		this.#armIdle(turn);

		// Prompt. Updates stream through the connection's onUpdate callback.
		try {
			// Nothing to cancel before the prompt RPC exists; see promptStarted.
			turn.promptStarted = true;
			const result = await conn.prompt(turn.sessionId, request.prompt, request.images, request.contextBlock);
			if (turn.closed) return;
			turn.sawResult = true;
			const mapped = mapStopReason(result.stopReason);
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: mapped.status,
				response: turn.response.text,
				error: mapped.error,
				finished: true,
				aborted: mapped.aborted,
			});
		} catch (err) {
			if (turn.closed) return;
			const aborted = turn.aborted;
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: aborted ? "OK" : "ERROR",
				response: turn.response.text,
				error: aborted ? undefined : `ACP prompt failed: ${describe(err)}`,
				finished: true,
				aborted,
			});
		}
	}

	#makeHandle(turn: ActiveTurn): TurnHandle {
		return {
			id: turn.id,
			outcome: turn.outcome,
			next: () => this.#nextActivity(turn),
			pushExternal: (activity) => this.pushExternal(activity),
		};
	}

	async #nextActivity(turn: ActiveTurn): Promise<DriverActivity | null> {
		for (;;) {
			if (turn.buffer.length > 0) return turn.buffer.shift() ?? null;
			if (turn.closed) return null;
			await new Promise<void>((r) => turn.wake.push(r));
		}
	}

	#emit(turn: ActiveTurn, activity: DriverActivity): void {
		if (turn.closed) return;
		if (turn.wake.length > 0) turn.wake.shift()!();
		turn.buffer.push(activity);
	}

	#onConnectionUpdate(sessionId: string | null, update: unknown): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		if (sessionId !== null && sessionId !== turn.sessionId) return;
		if (turn.idleTimer) turn.idleTimer.refresh();
		const mapped = mapUpdate(update);
		if (!mapped) return;
		switch (mapped.kind) {
			case "text": {
				const emit = turn.response.append(mapped.delta);
				if (emit) this.#emit(turn, { type: "text", delta: emit });
				return;
			}
			case "thought": {
				this.#emit(turn, { type: "thought", delta: mapped.delta });
				return;
			}
			case "tool_start": {
				const entry = { name: mapped.name, args: mapped.args, diff: mapped.diff };
				turn.toolCalls.set(mapped.toolCallId, entry);
				turn.lastNativeTool = { ...entry };
				this.#emit(turn, { type: "tool_start", name: mapped.name, args: mapped.args });
				return;
			}
			case "tool_done": {
				let entry = turn.toolCalls.get(mapped.toolCallId);
				if (!entry && turn.lastNativeTool) {
					// Unknown id with a recent native tool: adopt it (supersede).
					entry = { ...turn.lastNativeTool };
					turn.toolCalls.set(mapped.toolCallId, entry);
					turn.lastNativeTool = undefined;
				}
				const name = entry?.name ?? "tool";
				const args = entry?.args ?? {};
				// Native diff from the stored tool_call frame; the update's own
				// diff (future builds) wins when present.
				this.#emit(turn, { type: "tool_done", name, args, output: mapped.output, diff: mapped.diff ?? entry?.diff });
				return;
			}
			case "tool_error": {
				const entry = turn.toolCalls.get(mapped.toolCallId);
				const name = entry?.name ?? "tool";
				this.#emit(turn, { type: "tool_error", name, message: mapped.message });
				return;
			}
			case "replay_user":
				return; // load replay: history, never live text
		}
	}

	#onConnectionExit(conn: AcpConnection, info: { stderrTail: string }): void {
		if (this.#conn !== conn) {
			// A replaced connection reporting its death late (RC01's signal
			// handler intercepts SIGTERM and can outlive its replacement by
			// seconds): its turn is long gone and the new connection owns the
			// driver state. Clobbering #conn here would orphan the live one.
			this.#log("stale-connection-exited", { tail: info.stderrTail.slice(-200) });
			return;
		}
		const turn = this.#active;
		this.#conn = undefined;
		this.#state = "dead";
		this.#log("connection-exited", { tail: info.stderrTail.slice(-200) });
		if (!turn || turn.closed) return;
		if (turn.aborted || turn.sawResult) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: turn.response.text.length > 0 || turn.sawResult ? "OK" : "UNKNOWN",
				response: turn.response.text,
				finished: true,
				aborted: turn.aborted,
			});
			return;
		}
		this.#failTurn(turn, info.stderrTail.trim() || "ACP server exited mid-turn");
	}

	#ensureConnection(request: DriverTurnRequest): Promise<AcpConnection> {
		if (this.#conn?.alive) return Promise.resolve(this.#conn);
		this.#generation += 1;
		this.#state = "starting";
		this.#stats.spawns += 1;
		const conn = new AcpConnection({
			bin: resolveAcpBinary(typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin),
			binArgs: this.#opts.binArgs,
			extraEnv: this.#opts.extraEnv,
			authUrlFile: this.#opts.authUrlFile,
			cwd: request.cwd,
			mcpServers: this.#opts.mcpServers,
			log: (msg, data) => this.#log(msg, data),
			// Fail-closed permissions: only turns with skipPermissions answer allow.
			permissions: () => (this.#active?.request.skipPermissions ? "auto" : "deny"),
			onUpdate: (sessionId, update) => this.#onConnectionUpdate(sessionId, update),
			onExit: (info) => this.#onConnectionExit(conn, info),
		});
		this.#conn = conn;
		this.#log("spawn", { bin: resolveAcpBinary(typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin) });
		return conn
			.start()
			.then(() => {
				this.#serverVersion = conn.serverVersion();
				const info = conn.agentInfo as { name?: unknown; title?: unknown } | undefined;
				this.#agentInfo = {
					name: typeof info?.name === "string" ? info.name : undefined,
					title: typeof info?.title === "string" ? info.title : undefined,
				};
				this.#state = "ready";
				return conn;
			})
			.catch((err) => {
				// A server that spawned but failed the handshake (init timeout,
				// auth hang) must not leak: it is detached, so it outlives pi.
				this.#state = "dead";
				this.#conn = undefined;
				conn.kill();
				this.#log("start-failed", { message: describe(err) });
				throw err;
			});
	}

	/** Gate D abort. RC01 has no session/cancel: probe it once per connection,
	 *  then either wait for the cancelled result or tear down. */
	async #abortTurn(turn: ActiveTurn): Promise<void> {
		if (turn.closed) return;
		turn.aborted = true;
		turn.abortedBy = "signal";
		const conn = this.#conn;
		// No session yet (killed during setup), no live connection, or a server
		// already known not to implement cancel: teardown directly.
		if (!conn?.alive || turn.sessionId === "" || !turn.promptStarted || this.#cancelUnsupported()) {
			this.#teardownAbort(turn);
			return;
		}
		try {
			const probe = await conn.cancel(turn.sessionId);
			conn.cancelSupported = probe.supported;
			this.#lastCancelSupported = probe.supported;
			if (!probe.supported) {
				this.#log("cancel-unsupported", { build: this.#serverVersion });
				this.#teardownAbort(turn);
				return;
			}
			// Cancel accepted: the prompt result (stopReason cancelled) settles
			// the turn through the normal path. Safety net below in case the
			// server never answers.
			const started = this.#nowMs();
			const check = setInterval(() => {
				if (turn.closed) {
					clearInterval(check);
					return;
				}
				if (this.#nowMs() - started > 10_000) {
					clearInterval(check);
					this.#teardownAbort(turn);
				}
			}, 250);
		} catch (err) {
			this.#log("cancel-failed", { message: describe(err) });
			this.#teardownAbort(turn);
		}
	}

	#cancelUnsupported(): boolean {
		return this.#conn?.cancelSupported === false;
	}

	/** Gate D teardown: reject everything pending, kill the process. The turn
	 *  settles through the connection-exit path as aborted. */
	#teardownAbort(turn: ActiveTurn): void {
		this.#stats.kills += 1;
		this.#log("teardown-abort", { sessionId: turn.sessionId });
		turn.aborted = true;
		this.#conn?.abortAll("abort: connection torn down");
		this.#conn?.kill();
	}

	#createTurn(request: DriverTurnRequest): ActiveTurn {
		let resolve!: (o: TurnOutcome) => void;
		const outcome = new Promise<TurnOutcome>((r) => (resolve = r));
		const turn: ActiveTurn = {
			id: randomUUID().slice(0, 8),
			request,
			sessionId: "",
			buffer: [],
			wake: [],
			closed: false,
			resolve,
			outcome,
			response: new TextAccumulator(),
			sawResult: false,
		promptStarted: false,
			aborted: false,
			abortedBy: null,
			parks: 0,
			overallDeadline: null,
			overallRemainingMs: null,
			toolCalls: new Map(),
		};
		return turn;
	}

	// --- timers ----------------------------------------------------------------

	#overallBudgetMs(turn: ActiveTurn): number {
		return (turn.request.timeoutMin ?? 10) * 60_000;
	}

	#idleBudgetMs(turn: ActiveTurn): number {
		return (turn.request.inactivityMin ?? 5) * 60_000;
	}

	#nowMs(): number {
		return Date.now();
	}

	#armOverall(turn: ActiveTurn): void {
		const budget = this.#overallBudgetMs(turn);
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		// Parked before timers armed (setup-time park): the turn is PAUSED from
		// birth. Keep the pause invariant (deadline === null) and store the full
		// budget; kickIdle() resumes the timer on unpark. A stale non-null
		// deadline here would make the next #pauseOverall recompute the
		// remaining budget against a wall-clock instant that never ran.
		if (turn.parks > 0) {
			turn.overallDeadline = null;
			turn.overallRemainingMs = budget;
			return;
		}
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, budget);
	}

	#startOverallTimer(turn: ActiveTurn, ms: number): void {
		// The deadline lives HERE, not just in the callers: the running branch
		// of #armOverall never assigns it, and #pauseOverall keys off
		// `deadline !== null` to do anything at all. Without this line every
		// post-arm park is a silent no-op and the timer ticks through the park.
		turn.overallDeadline = this.#nowMs() + ms;
		turn.overallTimer = setTimeout(() => {
			if (turn.closed) return;
			turn.abortedBy = "timer";
			this.#log("timeout", { sessionId: turn.sessionId });
			this.#conn?.abortAll("turn deadline");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP turn exceeded the ${(this.#overallBudgetMs(turn) / 60_000) | 0}m deadline`);
		}, ms);
	}

	/** Pause WITHOUT resetting the deadline (remaining-budget semantics: the
	 *  overall timer is a turn deadline, not an inactivity guard). */
	#pauseOverall(turn: ActiveTurn): void {
		if (turn.overallDeadline === null) return;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		turn.overallTimer = undefined;
		turn.overallRemainingMs = Math.max(0, turn.overallDeadline - this.#nowMs());
		// Null the deadline: a nested park (parks > 1) must not recompute the
		// remaining budget against a stale wall-clock instant — parked time does
		// not consume budget.
		turn.overallDeadline = null;
	}

	#resumeOverall(turn: ActiveTurn): void {
		if (turn.overallRemainingMs === null) return;
		const remaining = turn.overallRemainingMs;
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, remaining);
	}

	#armIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		if (turn.parks > 0) return; // parked: idle timer resumes on unpark
		turn.idleTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log("stall", { sessionId: turn.sessionId });
			this.#conn?.abortAll("idle stall");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP stalled for ${(this.#idleBudgetMs(turn) / 60_000) | 0}m with no output`);
		}, this.#idleBudgetMs(turn));
	}

	#clearIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		turn.idleTimer = undefined;
	}

	// --- settling ----------------------------------------------------------------

	#settle(turn: ActiveTurn, outcome: TurnOutcome): void {
		if (turn.closed) return;
		turn.closed = true;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		this.#active = undefined;
		this.#state = this.#conn?.alive ? "ready" : "dead";
		if (outcome.conversationId) this.#lastSessionId = outcome.conversationId;
		for (const wake of turn.wake) wake();
		turn.wake = [];
		if (outcome.aborted && turn.abortedBy === null) turn.abortedBy = "signal";
		turn.resolve(outcome);
		try {
			this.#onTurnEnd?.(outcome);
		} catch {
			/* listener errors must not break settling */
		}
	}

	#failTurn(turn: ActiveTurn, message: string): void {
		this.#settle(turn, {
			conversationId: turn.sessionId,
			status: "ERROR",
			response: turn.response.text,
			error: message,
			finished: true,
			aborted: turn.aborted,
		});
	}

	#log(msg: string, data?: unknown): void {
		const line = `${new Date().toISOString().slice(11, 19)} ${msg}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}`;
		this.#lifecycle.push(line);
		if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
		this.#opts.log?.(msg, data);
	}

	// --- TurnDriver surface ----------------------------------------------------

	async close(reason: "recycle" | "shutdown", cause?: string): Promise<void> {
		if (reason === "shutdown") this.#shutdown = true;
		this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);
		const turn = this.#active;
		if (turn && !turn.closed) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: "ERROR",
				response: turn.response.text,
				error: `ACP driver ${reason}ed mid-turn${cause ? ` (${cause})` : ""}`,
				finished: true,
				aborted: false,
			});
		}
		this.#conn?.abortAll(`driver ${reason}`);
		this.#conn?.kill();
		this.#conn = undefined;
		this.#state = "dead";
	}

	snapshot(): DriverSnapshot {
		return {
			state: this.#state,
			pid: this.#conn?.pid,
			conversationId: this.#active?.sessionId ?? this.#lastSessionId,
			stats: {
				spawns: this.#stats.spawns,
				turns: this.#stats.turns,
				reused: 0,
				recycles: this.#stats.kills,
				lastRecycleReason: undefined,
				recycleReasons: {},
			},
			lifecycle: [...this.#lifecycle],
			engine: "acp",
			acp: {
				sessionId: this.#active?.sessionId ?? this.#lastSessionId,
				prompts: this.#stats.turns,
				sessionsCreated: this.#stats.sessionsCreated,
				sessionsLoaded: this.#stats.sessionsLoaded,
				kills: this.#stats.kills,
				cancelSupported: this.#conn?.cancelSupported ?? this.#lastCancelSupported,
				serverVersion: this.#serverVersion,
				// Connections beyond the first are server restarts (Gate D kills,
				// stale-exit replacements) = reconnects.
				reconnects: Math.max(0, this.#stats.spawns - 1),
				agentName: this.#agentInfo?.name,
				agentTitle: this.#agentInfo?.title,
			},
		};
	}
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// re-exported for the extension's doctor (server version display)
export type { AcpMcpServer } from "./connection.js";
