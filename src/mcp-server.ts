// Capability-gated MCP server: exposes pi's tools to agy over Streamable HTTP.
//
// agy reads .agents/mcp_config.json from its --add-dir directories (verified),
// NOT from cwd. So we write our config into a bridge-controlled dir and the
// provider passes that dir as an EXTRA --add-dir. AskAntigravity omits it, so
// its agy starts plain. The user's global agy config is never touched.
//
// Hardening:
//   - The whole request handler is wrapped so a client error (ECONNRESET on a
//     killed-mid-call agy) can never crash the pi process.
//   - Per-process config dir (agy-mcp-<pid>): concurrent pi sessions each own
//     their file; no shared-file race, no cross-session routing.
//   - Shared-secret header: agy sends it from the config; a browser cannot set a
//     custom header on a simple cross-origin POST, so this blocks CSRF against
//     the loopback server. Combined with 127.0.0.1 binding.
//   - Request body size cap.
//
// The bridge routes calls through the provider's toolUse round-trip; it
// needs no privileged pi API.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { GATED_AGY_TOOL_SET } from "./approval-hook.js";

/** Tools we do NOT expose to agy: it would just error (the provider is already
 *  antigravity, so the tool's own guard refuses; advertising it is noise). */
const SKIP_CIRCULAR = new Set(["AskAntigravity"]);

const BRIDGE_MCP_KEY = "pi-antigravity-bridge";
/** Shared-secret header every bridge request must carry. Exported: the ACP
 *  engine's mcpServers registration needs the same header name (the stream
 *  engine gets it via .agents/mcp_config.json; ACP gets it via headers[]). */
export const TOKEN_HEADER = "x-bridge-token";
const MAX_BODY_BYTES = 1_000_000;

// --- approval gate (docs/TODO.md 2.5) ---------------------------------------

/** stdin JSON of a PreToolUse hook, forwarded verbatim by the bundled poll
 *  script. Only toolCall is load-bearing here. */
export interface ApprovalPayload {
	toolCall: { name: string; args: Record<string, unknown> };
	stepIdx?: number;
	conversationId?: string;
	[key: string]: unknown;
}

/** Terminal decision for a parked approval (mirrors GateDecision from
 *  approval-gate.ts; deny MUST carry a reason - it is the only feedback
 *  agy's model gets, see V2). */
export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

/** Provider-facing park controls: ticket verification for the shadow tools'
 *  marker calls, and completion when pi's tool result maps to a decision. */
export interface ApprovalParkApi {
	/** True while the ticket is still parked (unanswered, unexpired). */
	has(ticket: string): boolean;
	/** Settle a ticket. False when the id is unknown or already terminal. */
	resolve(ticket: string, decision: ApprovalDecision): boolean;
}

/** Human-decision latency budget for one parked approval. The staged hook
 *  timeout (approval-hook.stagedTimeoutSeconds) exceeds this with margin:
 *  a timed-out hook soft-passes (V3), so the park must time out FIRST and
 *  print a deny. Mirrors the G9 park budget. */
export const APPROVAL_PARK_TIMEOUT_MS = 480_000;

export interface McpServerHandle {
	port: number;
	/** Shared secret for TOKEN_HEADER. Callers that register the bridge with
	 *  an engine other than the stream-json discovery file need it. */
	token: string;
	/** Approval-gate park controls (docs/TODO.md 2.5). */
	approvals: ApprovalParkApi;
	close: () => Promise<void>;
}

export interface McpStartResult {
	ok: boolean;
	port?: number;
	handle?: McpServerHandle;
	reason?: string;
}

/** Provider-owned bridge surface. The provider builds the tool catalog
 *  (config-filtered: none|mcp|all + skills) and owns the toolUse round-trip:
 *  onToolCall parks the call, ends the pi assistant message with stopReason
 *  "toolUse" for the REAL pi tool, and resolves when pi hands back the
 *  toolResult on the next stream call. Fail-closed: the provider enforces a
 *  480s timeout and rejects when no agy turn is active. */
export interface McpBridgeDeps {
	listTools(): Array<{ name: string; description: string; inputSchema: object }>;
	onToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<import("./provider.js").BridgeCallResultShape>;
	/** Approval gate: called once per parked POST /approval, right after the
	 *  early-ack. The provider interrupts the pi-side view of the agy turn and
	 *  emits the shadow toolUse; the decision returns via approvals.resolve.
	 *  Optional: absent = every approval POST is denied directly (fail closed). */
	onApproval?(ticket: string, payload: ApprovalPayload): void;
}

/** Clamp an unsupported MCP-Protocol-Version header down to the SDK's LATEST.
 *
 *  agy negotiates a protocol version newer than this SDK ships (e.g. 2026-07-28
 *  vs LATEST 2025-11-25). initialize is exempt from the transport's header
 *  check, and the SDK's initialize handler already downgrades the body version
 *  itself, but EVERY follow-up (tools/list, tools/call,
 *  notifications/initialized) is validated against the header -> 400 +
 *  transport-error. This server is stateless (a fresh transport per request),
 *  so it cannot track the negotiated version across requests; rewriting any
 *  unsupported value to LATEST is the correct, spec-friendly downgrade. The
 *  Node->Web conversion (Hono getRequestListener) builds the Web Request from
 *  req.rawHeaders, NOT the parsed req.headers object, so the value must be
 *  rewritten in the raw array (kept in sync with req.headers for any other
 *  reader). */
function clampProtocolVersionHeader(req: http.IncomingMessage): void {
	const sent = req.headers["mcp-protocol-version"];
	if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return;
	req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
	const raw = req.rawHeaders;
	for (let i = 0; i < raw.length - 1; i += 2) {
		if (raw[i].toLowerCase() === "mcp-protocol-version") raw[i + 1] = LATEST_PROTOCOL_VERSION;
	}
}

const BRIDGE_BASE = path.join(os.homedir(), ".pi", "agent", "antigravity-bridge");

/** Per-process config dir. Each pi session owns its own file, so concurrent
 *  sessions never race on or cross-route through one shared config. */
export function bridgeMcpConfigDir(): string {
	return path.join(BRIDGE_BASE, `agy-mcp-${process.pid}`);
}

function bridgeMcpConfigPath(): string {
	return path.join(bridgeMcpConfigDir(), ".agents", "mcp_config.json");
}

/** True if this process's bridge config exists (server is running). The
 *  provider uses this to decide whether to add the extra --add-dir. */
export function bridgeMcpConfigExists(): boolean {
	return fs.existsSync(bridgeMcpConfigPath());
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: alive but not ours to signal. ESRCH: no such process.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Best-effort cleanup of stale per-pid dirs left by crashed sessions. */
function sweepStaleBridgeDirs(): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(BRIDGE_BASE);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.startsWith("agy-mcp-")) continue;
		const pid = Number(name.slice("agy-mcp-".length));
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		if (isPidAlive(pid)) continue;
		try {
			fs.rmSync(path.join(BRIDGE_BASE, name), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/** Write our .agents/mcp_config.json (serverUrl + shared-secret header) so a
 *  provider agy that adds this dir via --add-dir discovers us. Atomic write. */
function writeBridgeMcpConfig(port: number, token: string): void {
	const cfgPath = bridgeMcpConfigPath();
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
	const cfg = {
		mcpServers: {
			[BRIDGE_MCP_KEY]: {
				serverUrl: `http://127.0.0.1:${port}/mcp`,
				headers: { [TOKEN_HEADER]: token },
			},
		},
	};
	const tmp = `${cfgPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, cfgPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing */
		}
		throw err;
	}
}

/** Remove this process's config dir. Safe to delete unconditionally: only this
 *  pid owns it. */
function removeBridgeMcpConfig(): void {
	try {
		fs.rmSync(bridgeMcpConfigDir(), { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/** Options for {@link registerExitCleanup}. */
export interface ExitCleanupOptions {
	/** Signals to catch for abrupt-termination cleanup. Default SIGINT/SIGTERM. */
	signals?: NodeJS.Signals[];
	/** Override the host-ownership check (tests). Default: process.listenerCount(sig) > 0. */
	hasHostListener?: (sig: NodeJS.Signals) => boolean;
}

/** Register best-effort cleanup of this process's bridge config dir on process
 *  exit, returning a disposer that removes the handlers (call from close()).
 *
 *  - 'exit' is always registered: synchronous, safe, catches process.exit() and
 *    event-loop drain. It does NOT fire on signal death.
 *  - For each signal in `signals` (default SIGINT/SIGTERM) we install a handler
 *    ONLY when the host process has no existing listener for it, so this
 *    extension never interferes with the host's own signal handling (e.g. a TUI
 *    cancel/quit flow). When we do install, we run cleanup then re-raise the
 *    signal so Node's default termination and exit code are preserved. Any
 *    abrupt termination that still bypasses these is swept on the next launch
 *    (sweepStaleBridgeDirs).
 *
 *  `hasHostListener` is injectable so tests can exercise both branches without
 *  depending on which signals the test runtime happens to listen on. */
export function registerExitCleanup(
	cleanup: () => void,
	opts: ExitCleanupOptions = {},
): () => void {
	const signals = opts.signals ?? ["SIGINT", "SIGTERM"];
	const hasHostListener = opts.hasHostListener ?? ((sig) => process.listenerCount(sig) > 0);
	const onExit = (): void => cleanup();
	process.once("exit", onExit);

	const installed: Array<{ sig: NodeJS.Signals; handler: () => void }> = [];
	for (const sig of signals) {
		// Host owns this signal: defer. The exit handler plus next-launch sweep
		// cover the abrupt-death gap without racing the host's handler.
		if (hasHostListener(sig)) continue;
		const handler = (): void => {
			cleanup();
			process.removeListener(sig, handler);
			// Re-raise so default termination runs with the right exit code, BUT
			// only if no host listener has appeared since install (ours is removed
			// now, so listenerCount reflects the host). If the host registered
			// later it already received this delivery alongside us; re-raising
			// would double-deliver (e.g. triggering a "Ctrl-C twice to quit" path
			// on the first keypress). When nobody owns it, re-raise safely.
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
		};
		process.once(sig, handler);
		installed.push({ sig, handler });
	}

	return (): void => {
		process.removeListener("exit", onExit);
		for (const { sig, handler } of installed) process.removeListener(sig, handler);
	};
}

export async function startMcpServer(
	deps: McpBridgeDeps,
	opts: {
		preferredPort?: number;
		log?: (s: string, d?: unknown) => void;
		/** Test override for the per-park timeout (deny, fail closed). */
		approvalTimeoutMs?: number;
	} = {},
): Promise<McpStartResult> {
	const log = opts.log ?? (() => {});
	const approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_PARK_TIMEOUT_MS;

	const listHandler = async () => {
		const tools = deps.listTools();
		log("list-tools", { count: tools.length });
		return { tools };
	};

	const callHandler = async (request: { params: { name: string; arguments?: unknown } }, signal?: AbortSignal) => {
		const { name, arguments: args } = request.params;
		// Progress probe: agy's MCP client killed long bridge calls at exactly
		// ~180s (see ACP-PROTOCOL-REFERENCE). If its requests ever carry a
		// progressToken, MCP progress notifications become a testable zero-UX
		// fix for that deadline; log presence to find out.
		const meta = (request.params as { _meta?: { progressToken?: unknown } })._meta;
		if (meta && meta.progressToken !== undefined) {
			log("progress-token", { name, token: String(meta.progressToken) });
		}
		const callId = crypto.randomUUID();
		log("call-tool", { name, callId });
		try {
			const r = await deps.onToolCall(
				callId,
				name,
				(args && typeof args === "object" ? args : {}) as Record<string, unknown>,
				signal ?? new AbortController().signal,
			);
			const content =
				r.content && r.content.length > 0 ? r.content : [{ type: "text", text: JSON.stringify(r) }];
			log("call-tool-ok", { name, callId });
			return { content, isError: r.isError ?? false };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log("call-tool-fail", { name, callId, msg });
			return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
		}
	};

	const makeServer = (signal: AbortSignal) => {
		const s = new Server(
			{ name: "pi-antigravity-bridge", version: "1.1.0" },
			{ capabilities: { tools: {} } },
		);
		s.setRequestHandler(ListToolsRequestSchema, listHandler);
		s.setRequestHandler(CallToolRequestSchema, (request) => callHandler(request, signal));
		return s;
	};

	// Shared secret: agy sends it from the config headers. Browsers cannot set
	// custom headers on a simple cross-origin POST, so this blocks web CSRF
	// against the loopback server; local clients need the token too.
	const token = crypto.randomUUID();
	sweepStaleBridgeDirs();

	// --- approval park (docs/TODO.md 2.5) ------------------------------------
	// Ticket -> parked approval. A settled ticket STAYS in the map until its
	// terminal decision is delivered to a poll, so the hook never 404s on the
	// answer; an unknown/expired ticket 404s and the hook fails closed.
	const parks = new Map<
		string,
		{ name: string; since: number; timer: NodeJS.Timeout; terminal?: ApprovalDecision }
	>();
	const settlePark = (ticket: string, decision: ApprovalDecision): boolean => {
		const p = parks.get(ticket);
		if (!p || p.terminal) return false;
		p.terminal = decision;
		clearTimeout(p.timer);
		return true;
	};
	const approvalsApi: ApprovalParkApi = {
		has: (ticket) => {
			const p = parks.get(ticket);
			return p !== undefined && p.terminal === undefined;
		},
		resolve: (ticket, decision) => settlePark(ticket, decision),
	};
	const decisionBody = (d: ApprovalDecision): string =>
		d.allow ? JSON.stringify({ decision: "allow" }) : JSON.stringify({ decision: "deny", reason: d.reason });
	const denyDirect = (res: http.ServerResponse, reason: string): void => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(decisionBody({ allow: false, reason }));
	};
	const tokenOk = (req: http.IncomingMessage): boolean => {
		const received = req.headers[TOKEN_HEADER];
		return (
			typeof received === "string" &&
			received.length === token.length &&
			crypto.timingSafeEqual(Buffer.from(received), Buffer.from(token))
		);
	};
	const readBody = async (req: http.IncomingMessage): Promise<string | null> => {
		let body = "";
		let bytes = 0;
		for await (const chunk of req) {
			body += chunk;
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) return null;
		}
		return body;
	};
	const approvalRoute = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		route: string,
	): Promise<void> => {
		if (!tokenOk(req)) {
			log("unauthorized", { url: req.url });
			res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
			return;
		}
		if (req.method === "POST" && route === "/approval") {
			const body = await readBody(req);
			if (body === null) {
				res.writeHead(413, { "content-type": "application/json", connection: "close" }).end('{"error":"payload too large"}');
				return;
			}
			let payload: ApprovalPayload;
			try {
				const parsed = JSON.parse(body) as ApprovalPayload;
				const name = parsed?.toolCall?.name;
				if (typeof name !== "string" || name.length === 0) throw new Error("no toolCall.name");
				if (!parsed.toolCall.args || typeof parsed.toolCall.args !== "object") {
					parsed.toolCall.args = {};
				}
				payload = parsed;
			} catch {
				res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid payload"}');
				return;
			}
			// Defense in depth: the hooks matcher should never let an ungated
			// tool through; deny directly instead of parking.
			if (!GATED_AGY_TOOL_SET.has(payload.toolCall.name)) {
				log("approval-ungated", { name: payload.toolCall.name });
				denyDirect(res, `tool ${payload.toolCall.name} is not in the approval matcher set`);
				return;
			}
			if (typeof deps.onApproval !== "function") {
				log("approval-unwired", { name: payload.toolCall.name });
				denyDirect(res, "approval gate is not wired; denying");
				return;
			}
			const ticket = crypto.randomUUID();
			const timer = setTimeout(() => {
				// Fail closed FIRST: the staged hook timeout is longer than this
				// park budget (V3: a hook outliving its timeout soft-passes, so the
				// park must answer the deny before the hook is killed).
				settlePark(ticket, { allow: false, reason: `approval gate timed out after ${Math.round(approvalTimeoutMs / 1000)}s` });
				log("approval-timeout", { ticket, name: payload.toolCall.name });
			}, approvalTimeoutMs);
			parks.set(ticket, { name: payload.toolCall.name, since: Date.now(), timer });
			log("approval-parked", { ticket, name: payload.toolCall.name });
			try {
				deps.onApproval(ticket, payload);
			} catch (e) {
				// A throwing provider must never hang the hook: settle deny now.
				log("approval-onapproval-fail", { ticket, msg: e instanceof Error ? e.message : String(e) });
				settlePark(ticket, { allow: false, reason: "approval gate internal error" });
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket }));
			return;
		}
		if (req.method === "GET" && route.startsWith("/approval/")) {
			const ticket = decodeURIComponent(route.slice("/approval/".length));
			const p = parks.get(ticket);
			if (!p) {
				// Unknown or already delivered: the hook fails closed on a 404.
				res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown ticket"}');
				return;
			}
			if (p.terminal) {
				parks.delete(ticket); // delivered; a repeat poll 404s (fail closed)
				log("approval-delivered", { ticket, name: p.name });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(decisionBody(p.terminal));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "pending" }));
			return;
		}
		res.writeHead(405).end();
	};

	return new Promise<McpStartResult>((resolve) => {
		const httpServer = http.createServer(async (req, res) => {
			// #1: a client-side stream error must never crash pi.
			req.on("error", (e) => {
				log("request-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(400).end();
					else res.end();
				} catch {
					/* socket already gone */
				}
			});
			try {
				if (req.url?.includes("/.well-known/")) {
					res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
					return;
				}
				const route = (req.url ?? "").split("?")[0];
				if (route === "/approval" || route.startsWith("/approval/")) {
					await approvalRoute(req, res, route);
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				// #3: require the shared-secret header. Constant-time compare so a
				// timing oracle can't recover the token byte-by-byte.
				if (!tokenOk(req)) {
					log("unauthorized", { url: req.url });
					res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
					return;
				}
				// #4: cap request body size.
				let body = "";
				let bytes = 0;
				let tooLarge = false;
				for await (const chunk of req) {
					body += chunk;
					bytes += chunk.length;
					if (bytes > MAX_BODY_BYTES) {
						tooLarge = true;
						break;
					}
				}
				if (tooLarge) {
					// We bailed before draining the oversize body; close the connection
					// so the unread bytes can't desync the next request on this socket.
					res.writeHead(413, { "content-type": "application/json", connection: "close" }).end('{"error":"payload too large"}');
					return;
				}
				let parsed: { method?: string; params?: { protocolVersion?: string } };
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400).end("invalid json");
					return;
				}
				// Protocol version: agy negotiates a version newer than this SDK ships
				// (e.g. 2026-07-28 vs LATEST 2025-11-25). initialize is exempt from the
				// transport's header check and the SDK downgrades its body version
				// itself, but every follow-up (tools/list, tools/call,
				// notifications/initialized) is header-checked -> 400 + transport-error.
				// Clamp unsupported headers to LATEST. Stateless server (fresh transport
				// per request) can't track the negotiated version across requests.
				clampProtocolVersionHeader(req);
				// #6: cancel the invoked tool if agy disconnects mid-call (e.g. killed
				// by the runner timeout). req 'close' would fire on normal completion,
				// so we only abort on client abort / response-closed-before-finished.
				const ac = new AbortController();
				req.on("aborted", () => ac.abort());
				res.on("close", () => {
					if (!res.writableEnded) ac.abort();
				});
				try {
					// Stateless: a fresh transport+server per request.
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					transport.onerror = (e: Error) => log("transport-error", e.message);
					const server = makeServer(ac.signal);
					await server.connect(transport);
					await transport.handleRequest(req, res, parsed as object);
				} catch (e) {
					log("handleRequest-error", e instanceof Error ? e.message : String(e));
					if (!res.headersSent) res.writeHead(500).end();
				}
			} catch (e) {
				// Catch-all (e.g. errors during body read/clamp) so pi never crashes.
				log("request-handler-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(500).end();
				} catch {
					/* socket gone */
				}
			}
		});

		httpServer.on("error", (e) => {
			log("http-error", e instanceof Error ? e.message : String(e));
			resolve({ ok: false, reason: `http server error: ${e instanceof Error ? e.message : String(e)}` });
		});

		httpServer.listen(opts.preferredPort ?? 0, "127.0.0.1", () => {
			const addr = httpServer.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			if (!port) {
				resolve({ ok: false, reason: "failed to bind" });
				return;
			}
			try {
				writeBridgeMcpConfig(port, token);
				log("bridge-config-written", { port, path: bridgeMcpConfigPath() });
			} catch (e) {
				log("bridge-config-write-failed", e instanceof Error ? e.message : String(e));
			}
			// Clean up the config dir on abrupt termination (SIGINT/SIGTERM/crash)
			// where session_shutdown -> close() does not run. Disposed in close().
			const disposeExitCleanup = registerExitCleanup(removeBridgeMcpConfig);
			log("listening", { port });
			resolve({
				ok: true,
				port,
				handle: {
					port,
					token,
					approvals: approvalsApi,
					close: async () => {
						// Pending approvals fail closed on shutdown: the hook gets a
						// terminal deny instead of a 404 on its next poll.
						for (const [ticket, p] of [...parks]) {
							if (p.terminal) continue;
							settlePark(ticket, { allow: false, reason: "approval gate bridge shut down" });
						}
						await new Promise<void>((r) => httpServer.close(() => r()));
						removeBridgeMcpConfig();
						disposeExitCleanup();
						log("bridge-config-removed", { port });
						log("closed", { port });
					},
				},
			});
		});
	});
}
