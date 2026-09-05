// ACP connection: owns the agy_acp_server process, the JSON-RPC session over
// its stdio, and the protocol methods the driver needs. One connection hosts
// one session at a time (the driver's model), but the transport supports more.
//
// Protocol facts encoded here were verified live against
// agy_acp_server_20260818_01_RC01 (docs/ACP-PROTOCOL-REFERENCE.md):
//   - initialize: {protocolVersion:1, clientCapabilities{fs:false,terminal:false}}
//   - authenticate takes `methodId`; auth errors are -32000 with remediation in
//     data.message; the token persists in ~/.gemini/antigravity-acp/acp_token.json
//   - session/set_config_option takes `configId` (model value = FULL slug with
//     the effort tier baked in, e.g. gemini-3.8-flash-low)
//   - session/cancel returns -32601 on RC01 (not implemented) — the driver
//     treats that as "cancel unsupported" and falls back to teardown+kill
//   - session/request_permission is answered in-connection: policy per turn
//     (skipPermissions on -> first allow option; off -> first reject option,
//     fail-closed)
//   - session/load replays history as notifications BEFORE its response; the
//     driver suppresses updates while the load is in flight
//   - mcpServers entries: {name, type:"http", url, headers:[]} — headers is a
//     LIST; a dead URL is accepted at session time (lazy connect)

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAuthPort, readLastUrl } from "./browser-capture.js";
import { JsonRpcResponseError, JsonRpcSession } from "./jsonrpc.js";

export interface AcpMcpServer {
	name: string;
	type: "http" | "sse";
	url: string;
	headers: Array<{ name: string; value: string }>;
}

export interface AcpSessionInfo {
	sessionId: string;
}

/** Auth failed (-32000 family). Message carries the remediation the server
 *  provided plus the /agy auth-manual pointer. */
export class AcpAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpAuthError";
	}
}

export interface AcpConnectionOptions {
	/** Process working directory for the spawned server. */
	cwd: string;
	/** Resolved server binary (or node executable when binArgs carries the
	 *  fake-server script for tests). */
	bin: string;
	binArgs?: string[];
	extraEnv?: Record<string, string>;
	log: (msg: string, data?: unknown) => void;
	/** Verified `session/update` payloads (post-suppression). */
	onUpdate: (sessionId: string | null, update: unknown) => void;	/** Process exit. Fires exactly once. */
	onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
	/** mcpServers entries for session/new AND session/load (run 6: load takes
	 *  the same param). Evaluated lazily per call. */
	mcpServers?: () => AcpMcpServer[];
	/** Permission policy for session/request_permission, evaluated per request:
	 *  "auto" selects the first allow option; "deny" fail-closes to the first
	 *  reject option. Absent = deny (fail closed). */
	permissions?: () => "auto" | "deny";
	/** Record file for BROWSER-captured OAuth URLs (src/acp/browser-capture.ts).
	 *  The server hands the login URL only to the browser-open call, so the
	 *  wrapper records it there; the connection watches the file and logs
	 *  "auth-url" {url, port} for every new URL. */
	authUrlFile?: string;
}

const INIT_TIMEOUT_MS = 30_000;
const SESSION_OP_TIMEOUT_MS = 20_000;

export class AcpConnection {
	#opts: AcpConnectionOptions;
	#child: ChildProcess | undefined;
	#rpc: JsonRpcSession | undefined;
	#stderrTail = "";
	#exited = false;
	#killed = false;
	#suppressUpdates = false;
	#updateSessionId: string | null = null;
	agentInfo: Record<string, unknown> | undefined;
	/** Last known mode/model config echo from set_config_option results. */
	lastConfigOptions: unknown = undefined;
	#authUrlWatcher: fs.FSWatcher | undefined;
	#lastAuthUrl: string | null = null;

	constructor(opts: AcpConnectionOptions) {
		this.#opts = opts;
	}

	get alive(): boolean {
		return this.#child !== undefined && !this.#exited && !this.#killed;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get stderrTail(): string {
		return this.#stderrTail;
	}

	/** While true, session/update notifications are dropped: they are the
	 *  full-text history replay that precedes a session/load response, never
	 *  live generation (run 6). */
	set updateSuppression(flag: boolean) {
		this.#suppressUpdates = flag;
	}

	/** Spawn the server and perform the initialize handshake. Idempotent per
	 *  instance: call once. */
	async start(): Promise<void> {
		if (this.#child) return;
		const args = [...(this.#opts.binArgs ?? [])];
		const child = spawn(this.#opts.bin, args, {
			cwd: this.#opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			...(this.#opts.extraEnv ? { env: { ...process.env, ...this.#opts.extraEnv } } : {}),
		});
		this.#child = child;
		if (this.#opts.authUrlFile) this.#watchAuthUrl();
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		// Pipe failures arrive asynchronously as stream 'error' events; the sync
		// try/catch in #write cannot see them. Without this listener an EPIPE
		// (server died mid-handshake) is uncaught and kills pi.
		child.stdin?.on("error", (err) => {
			this.#opts.log("stdin-error", { message: err.message });
			if (!this.#exited && !this.#killed) this.#finish(err.message);
		});

		const rpc = new JsonRpcSession({
			send: (frame) => this.#write(frame),
			onRequest: (method, params) => this.#onServerRequest(method, params),
			onNotification: (method, params) => this.#onNotification(method, params),
			onParseError: (line) => this.#opts.log("parse-error", { line }),
		});
		this.#rpc = rpc;

		child.stdout?.on("data", (chunk: string) => rpc.feed(chunk));
		child.stderr?.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-8192);
		});
		child.on("error", (err) => {
			this.#opts.log("spawn-error", { message: err.message });
			this.#finish(err.message);
		});
		child.on("exit", (code, signal) => {
			this.#opts.log("exit", { code: code ?? signal ?? "?" });
			this.#finish(this.#stderrTail.trim());
		});

		const result = (await this.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
			INIT_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		const info = result?.agentInfo;
		if (typeof info === "object" && info !== null) this.agentInfo = info as Record<string, unknown>;
		this.#opts.log("initialized", { version: this.serverVersion() });
	}

	serverVersion(): string | undefined {
		const v = this.agentInfo?.version;
		return typeof v === "string" ? v : undefined;
	}

	/** True once the server answered -32601 for session/cancel on THIS
	 *  process (probed lazily by the driver; never assumed). */
	cancelSupported: boolean | null = null;

	async newSession(cwd: string): Promise<AcpSessionInfo> {
		const result = (await this.guarded(
			"session/new",
			{ cwd, mcpServers: this.#mcpServers() },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown>;
		const sessionId = result.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error("ACP session/new returned no sessionId");
		}
		this.#updateSessionId = sessionId;
		this.lastConfigOptions = result.configOptions;
		return { sessionId };
	}

	async loadSession(sessionId: string, cwd: string): Promise<void> {
		this.#updateSessionId = sessionId;
		this.updateSuppression = true;
		try {
			// History replay arrives as notifications BEFORE this resolves; the
			// suppression flag drops it (never live text).
			const result = (await this.request(
				"session/load",
				{ sessionId, cwd, mcpServers: this.#mcpServers() },
				SESSION_OP_TIMEOUT_MS,
			)) as Record<string, unknown> | undefined;
			this.lastConfigOptions = result?.configOptions;
		} finally {
			this.updateSuppression = false;
		}
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		const result = (await this.guarded(
			"session/set_config_option",
			{ sessionId, configId, value },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		this.lastConfigOptions = result?.configOptions;
	}

	/** No request timeout on purpose: the driver's overall/idle timers govern
	 *  the turn and fire abortAll on breach. */
	async prompt(
		sessionId: string,
		text: string,
		images: Array<{ data: string; mimeType: string }> = [],
		contextBlock?: { uri: string; text: string },
	): Promise<{ stopReason: string }> {
		// Block order: images, then the embedded-context resource (pi-side
		// digest), then the text question last (it refers to everything before
		// it). Shapes per the ACP v1 content-block schema; embeddedContext is
		// advertised in promptCapabilities (verified run 5).
		const blocks: Array<Record<string, unknown>> = [
			...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
		];
		if (contextBlock) {
			blocks.push({
				type: "resource",
				resource: {
					uri: contextBlock.uri,
					mimeType: "text/markdown",
					text: contextBlock.text,
				},
			});
		}
		blocks.push({ type: "text", text });
		const result = (await this.request("session/prompt", {
			sessionId,
			prompt: blocks,
		})) as Record<string, unknown> | undefined;
		const stopReason = result?.stopReason;
		if (typeof stopReason !== "string") {
			throw new Error("ACP session/prompt returned no stopReason");
		}
		return { stopReason };
	}

	/** Probe-and-cancel. Returns supported:false when the server does not
	 *  implement session/cancel (-32601 on RC01); other errors propagate as
	 *  translated Errors. Protocol probing stays inside the connection layer. */
	async cancel(sessionId: string): Promise<{ supported: boolean }> {
		try {
			await this.request("session/cancel", { sessionId }, SESSION_OP_TIMEOUT_MS);
			return { supported: true };
		} catch (err) {
			if (err instanceof JsonRpcResponseError && err.code === -32601) return { supported: false };
			throw translateError("session/cancel", err);
		}
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.guarded("session/close", { sessionId }, SESSION_OP_TIMEOUT_MS);
	}

	/** Protocol-level permission answering: policy from the driver ("auto"
	 *  selects the first allow option; "deny" fail-closes to the first reject
	 *  option). Never hangs: options are data from the server and the answer
	 *  is computed synchronously. */
	#onServerRequest(method: string, params: unknown): Promise<unknown> {
		if (method === "session/request_permission") {
			const options = (
				typeof params === "object" && params !== null ? (params as Record<string, unknown>).options : undefined
			) as Array<{ optionId?: string; kind?: string }> | undefined;
			const allow = options?.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
			const deny = options?.find((o) => typeof o.kind === "string" && o.kind.startsWith("reject"));
			const policy = this.#opts.permissions?.() ?? "deny";
			const chosen = policy === "auto" ? (allow ?? deny ?? options?.[0]) : (deny ?? options?.[0]);
			this.#opts.log("permission", { optionId: chosen?.optionId, policy });
			return Promise.resolve({ outcome: { outcome: "selected", optionId: chosen?.optionId } });
		}
		// fs/* and terminal/* are declined: our client capabilities are off and
		// agy keeps executing its own tools (plan §8 capability posture).
		this.#opts.log("unsupported-server-request", { method });
		return Promise.reject(new Error(`client capability not enabled: ${method}`));
	}

	#onNotification(method: string, params: unknown): void {
		if (method === "session/update") {
			if (this.#suppressUpdates) return; // load replay: history, not live text
			const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
			const sessionId = typeof p.sessionId === "string" ? p.sessionId : this.#updateSessionId;
			this.#opts.onUpdate(sessionId, p.update);
			return;
		}
		if (method === "auth_required") {
			this.#opts.log("auth-required", params);
			return;
		}
		this.#opts.log("notification", { method });
	}

	/** Wrap a request: -32000 family becomes AcpAuthError with the remediation
	 *  the server provided. */
	private async guarded(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		try {
			return await this.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (!this.#rpc || !this.alive) throw new Error("ACP connection is not running");
		try {
			return await this.#rpc.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	#mcpServers(): AcpMcpServer[] {
		try {
			return this.#opts.mcpServers?.() ?? [];
		} catch {
			return [];
		}
	}

	#write(frame: string): void {
		const stdin = this.#child?.stdin;
		if (!stdin || !stdin.writable || this.#exited) {
			this.abortAll("connection closed");
			return;
		}
		try {
			stdin.write(frame + "\n");
		} catch (err) {
			this.#opts.log("write-failed", { message: err instanceof Error ? err.message : String(err) });
			this.abortAll("connection closed");
		}
	}

	/** Gate D teardown: reject every pending request, then kill the process.
	 *  Nothing is ever written to the dying transport; no promise survives. */
	abortAll(reason: string): void {
		this.#rpc?.abortAll(reason);
	}
	kill(): void {
		if (this.#killed) return;
		this.#killed = true;
		this.abortAll("connection killed");
		const child = this.#child;
		if (!child || this.#exited) return;
		this.#opts.log("kill", { pid: child.pid ?? "?" });
		try {
			if (child.pid && process.platform !== "win32") {
				process.kill(-child.pid, "SIGTERM");
				setTimeout(() => {
					try {
						if (!this.#exited && child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}, 750);
			} else {
				child.kill("SIGTERM");
			}
		} catch {
			/* already gone */
		}
	}

	/** Surface OAuth login URLs captured by the BROWSER wrapper: every new
	 *  URL in the record file is logged once as "auth-url" {url, port}. Best
	 *  effort only - a broken watch never affects turns. */
	#watchAuthUrl(): void {
		const file = this.#opts.authUrlFile!;
		try {
			const watcher = fs.watch(file, () => this.#emitAuthUrl());
			// Without a listener, a watch 'error' event escapes as uncaught.
			watcher.on("error", () => {
				/* record file gone: login URL surfacing is off until respawn */
			});
			this.#authUrlWatcher = watcher;
		} catch {
			/* no watch; the one-shot check below still covers earlier writes */
		}
		this.#emitAuthUrl(); // URLs recorded before the watch started
	}

	#emitAuthUrl(): void {
		const url = readLastUrl(this.#opts.authUrlFile!);
		if (!url || url === this.#lastAuthUrl) return;
		this.#lastAuthUrl = url;
		this.#opts.log("auth-url", { url, port: parseAuthPort(url) });
	}

	#finish(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#authUrlWatcher?.close();
		this.#authUrlWatcher = undefined;
		this.abortAll(`connection exited: ${reason || "process gone"}`);
		this.#opts.onExit({ code: null, signal: null, stderrTail: this.#stderrTail });
	}
}

export function translateError(method: string, err: unknown): Error {
	if (err instanceof AcpAuthError) return err;
	if (err instanceof JsonRpcResponseError) {
		if (err.code === -32000) {
			const detail = typeof err.data === "object" && err.data !== null ? (err.data as { message?: unknown }).message : undefined;
			const detailText = typeof detail === "string" ? `: ${detail}` : `: ${err.message}`;
			return new AcpAuthError(`ACP authentication required for ${method}${detailText}. Run /agy auth to sign in; /agy auth-manual has manual steps.`);
		}
		// Typed protocol errors survive: callers probe .code (-32601 cancel-
		// unsupported, -32602 param shape). The method prefix is lost — describe()
		// callers that need it log the method at the call site.
		return err;
	}
	if (err instanceof Error) return err;
	return new Error(`ACP ${method} failed: ${String(err)}`);
}

/** Resolve the server binary: env > config > PATH. Resolution failure is a
 *  visible turn error naming what was tried (plan §9.5). */
/** Resolve the server binary: env > config > PATH. `~` expands to the home
 *  directory (spawn does not expand it). Resolution failure is a visible turn
 *  error naming what was tried (plan §9.5). */
export function resolveAcpBinary(configBin: string): string {
	const raw = process.env.AGY_ACP_BIN || (configBin.length > 0 ? configBin : "agy_acp_server.par");
	return raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
}
