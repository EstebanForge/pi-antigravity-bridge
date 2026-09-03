// Newline-delimited JSON-RPC 2.0 session over a stdio transport.
//
// Transport-agnostic by design: the caller supplies a `send` sink (writes one
// serialized frame + newline to the child's stdin) and feeds incoming bytes to
// `feed()`. Everything ACP-specific lives in connection.ts.
//
// Semantics verified live against agy_acp_server (20260818_01_RC01):
//   - requests are correlated by numeric id; responses reject the pending
//     promise on JSON-RPC `error` results;
//   - server-to-client REQUESTS (session/request_permission, fs/*, terminal/*)
//     arrive as messages with both `method` and `id` and are answered through
//     the handler registered via setRequestHandler;
//   - notifications (session/update, auth_required) carry no id;
//   - malformed lines are counted and dropped, never fatal (the parseAgyLine
//     lesson: a chatty banner must not kill the reader loop);
//   - `abortAll()` rejects every pending request (Gate D teardown: no promise
//     survives a killed connection).

export interface JsonRpcErrorShape {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcIncoming {
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorShape;
}

export type SendFn = (frame: string) => void;

export interface JsonRpcSessionOptions {
	send: SendFn;
	/** Server-to-client request (has method + id). Return the result value, or
	 *  throw to answer with a JSON-RPC error. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Server-to-client notification (method, no id). */
	onNotification?: (method: string, params: unknown) => void;
	/** Unparseable line (logged, never fatal). */
	onParseError?: (line: string) => void;
	/** Default timeout for requests without an explicit one (ms). 0 = none. */
	defaultTimeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	method: string;
}

export class JsonRpcSession {
	#send: SendFn;
	#opts: JsonRpcSessionOptions;
	#pending = new Map<number, Pending>();
	#nextId = 1;
	#aborted = false;
	#lineBuf = "";
	parseErrors = 0;

	constructor(opts: JsonRpcSessionOptions) {
		this.#opts = opts;
		this.#send = opts.send;
	}

	/** Feed raw transport bytes. Stdio chunks are NOT newline-aligned: bytes
	 *  are buffered and only complete lines are parsed (a frame split across a
	 *  64KB pipe boundary must never be dropped). */
	feed(chunk: string): void {
		this.#lineBuf += chunk;
		const lines = this.#lineBuf.split("\n");
		this.#lineBuf = lines.pop() ?? "";
		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			let msg: JsonRpcIncoming;
			try {
				msg = JSON.parse(line) as JsonRpcIncoming;
			} catch {
				this.parseErrors += 1;
				this.#opts.onParseError?.(line.slice(0, 200));
				continue;
			}
			this.#handleMessage(msg);
		}
	}

	#handleMessage(msg: JsonRpcIncoming): void {
		// Response to one of our requests.
		if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
			const id = Number(msg.id);
			const pending = this.#pending.get(id);
			if (!pending) return; // late response to an aborted request: drop
			this.#pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (msg.error) {
				pending.reject(new JsonRpcResponseError(msg.error));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}
		if (msg.method === undefined) return;
		// Server-to-client request: must be answered with the same id. The
		// handler is always invoked through Promise.resolve() so a synchronous
		// throw can never escape into the reader loop.
		if (msg.id !== undefined && msg.id !== null) {
			const id = msg.id;
			const handler = this.#opts.onRequest;
			if (!handler) {
				this.#sendError(id, -32601, `client does not support method: ${msg.method}`);
				return;
			}
			void Promise.resolve()
				.then(() => handler(msg.method as string, msg.params))
				.then((result) => {
					if (this.#aborted) return;
					this.#send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }));
				})
				.catch((err: unknown) => {
					if (this.#aborted) return;
					const message = err instanceof Error ? err.message : String(err);
					this.#sendError(id, -32000, message);
				});
			return;
		}
		// Notification.
		this.#opts.onNotification?.(msg.method, msg.params);
	}

	#sendError(id: number | string, code: number, message: string): void {
		if (this.#aborted) return;
		this.#send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	/** Send a request. Resolves with the result value; rejects on error
	 *  responses (JsonRpcResponseError), timeouts, or abortAll(). */
	request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.#aborted) return Promise.reject(new Error("connection aborted"));
		const id = this.#nextId++;
		const effective = timeoutMs ?? this.#opts.defaultTimeoutMs ?? 0;
		return new Promise<unknown>((resolve, reject) => {
			const pending: Pending = { resolve, reject, method };
			if (effective > 0) {
				pending.timer = setTimeout(() => {
					this.#pending.delete(id);
					reject(new Error(`ACP request timed out after ${effective}ms: ${method}`));
				}, effective);
			}
			this.#pending.set(id, pending);
			this.#send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
		});
	}

	/** Reject every pending request (Gate D teardown). The transport is going
	 *  away; nothing will ever be written again. */
	abortAll(reason: string): void {
		this.#aborted = true;
		for (const [id, pending] of this.#pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(`${reason} (request: ${pending.method})`));
			this.#pending.delete(id);
		}
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}

/** A JSON-RPC `error` result, preserving code + data (the -32602 `loc` paths
 *  and the -32601 method name are correction oracles; see the reference doc). */
export class JsonRpcResponseError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(error: JsonRpcErrorShape) {
		super(error.message);
		this.name = "JsonRpcResponseError";
		this.code = error.code;
		this.data = error.data;
	}
}
