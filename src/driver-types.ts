// Engine-agnostic turn-driver contract.
//
// Both turn engines (legacy stream-json driver in `driver.ts`, ACP driver in
// `acp/driver.ts`) implement `TurnDriver`, and everything above them — the
// provider's stream loop, the G9 round-trip store, the extension wiring —
// depends on this interface only. Types live here so the legacy module can be
// deleted (phase 4) without breaking imports.
//
// The ACP driver implements the same surface with protocol-native mechanics:
// no process recycle on profile drift, teardown-based abort (Gate D), and
// `session/load` resume. See docs/ACP-ADOPTION-PLAN.md section 9.

export type DriverState = "idle" | "starting" | "ready" | "running" | "dead";

export interface DriverProfile {
	cwd: string;
	model: string;
	effort?: string;
	mode: string;
	skipPermissions: boolean;
}

export interface DriverTurnRequest extends DriverProfile {
	/** Existing conversation/session to resume. Legacy: agy conversation id via
	 *  `--conversation`. ACP: sessionId via `session/load` (falls back to
	 *  `session/new` when the server no longer knows it). */
	conversationId?: string | null;
	prompt: string;
	/** Image blocks riding with the prompt. ACP forwards them as typed
	 *  content blocks (probe 2026-09-03: 64x64 two-tone PNG answered
	 *  correctly); the legacy CLI prompt is text-only and ignores them. */
	images?: Array<{ data: string; mimeType: string }>;
	/** ACP only: pi-side context delivered as a native `embeddedContext`
	 *  resource block instead of inline prompt text (G1 on ACP). Legacy
	 *  embeds the digest in the prompt string and ignores this. */
	contextBlock?: { uri: string; title: string; text: string };
	signal?: AbortSignal;
	/** Overall turn cap in minutes (default 10). Fractional values are valid
	 *  (tests use sub-minute caps). */
	timeoutMin?: number;
	/** Stdout-inactivity cap in minutes (default 5). */
	inactivityMin?: number;
}

export type AgyUsage = {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
};

export type DriverActivity =
	| { type: "text"; delta: string }
	/** Legacy emits a token count only; ACP carries the actual thought text in
	 *  `delta`. The provider renders whichever is present. */
	| { type: "thought"; tokens?: number; delta?: string }
	| { type: "tool_start"; stepId?: number; name: string; args: Record<string, unknown> }
	| {
			type: "tool_done";
			stepId?: number;
			name: string;
			args: Record<string, unknown>;
			output?: string;
			durationSeconds?: number;
			/** ACP only: the server's native edit diff from `tool_call`
			 *  content[] ({type:"diff", path, oldText?, newText}). Legacy never
			 *  sets it; the provider renders it without any git subprocess. */
			diff?: { path: string; oldText?: string; newText: string };
	  }
	| { type: "tool_error"; stepId?: number; name: string; message: string }
	| { type: "usage"; usage: AgyUsage }
	/** Synthetic: injected by the provider when the MCP bridge receives a call
	 *  (G9). Parks the turn: output is expected to stall while pi executes the
	 *  tool, so the driver suspends its idle/overall timers. */
	| { type: "bridge_call"; callId: string; name: string; args: Record<string, unknown> };

export interface TurnOutcome {
	conversationId?: string;
	status: "OK" | "ERROR" | "UNKNOWN";
	response: string;
	error?: string;
	usage?: AgyUsage;
	finished: boolean;
	aborted: boolean;
}

export interface TurnHandle {
	id: string;
	/** Resolves when the turn settles (result event, exit, abort, recycle). */
	outcome: Promise<TurnOutcome>;
	/** Pull the next activity. Resolves null once the activity stream closes. */
	next(): Promise<DriverActivity | null>;
	/** Inject a synthetic activity (bridge inbox). No-op after settle. */
	pushExternal(activity: DriverActivity): void;
}

export interface DriverSnapshot {
	state: DriverState;
	pid?: number;
	conversationId?: string;
	stats: {
		spawns: number;
		turns: number;
		reused: number;
		recycles: number;
		lastRecycleReason?: string;
		recycleReasons: Record<string, number>;
	};
	lifecycle: string[];
	/** Present on ACP snapshots; absent on legacy. */
	engine?: "acp";
	acp?: {
		sessionId?: string;
		prompts: number;
		sessionsCreated: number;
		sessionsLoaded: number;
		kills: number;
		/** null = never probed on this server process. */
		cancelSupported: boolean | null;
		serverVersion?: string;
		/** Connections beyond the first this driver process made = server
		 *  restarts (Gate D kills + stale-exit replacements). */
		reconnects: number;
		/** From the initialize handshake agentInfo block. */
		agentName?: string;
		agentTitle?: string;
	};
}

/** The engine contract. Everything above the driver depends on this interface
 *  only; `AgyDriver` and `AcpDriver` both implement it. */
export interface TurnDriver {
	readonly state: DriverState;
	readonly activeHandle: TurnHandle | null;
	run(request: DriverTurnRequest): Promise<TurnHandle>;
	/** Re-attach to the active turn (pi toolUse continuation). */
	reentry(): TurnHandle | null;
	/** Resume turn timers after a parked G9 round-trip settles. */
	kickIdle(): void;
	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined);
	snapshot(): DriverSnapshot;
	close(reason: "recycle" | "shutdown", cause?: string): Promise<void>;
}
