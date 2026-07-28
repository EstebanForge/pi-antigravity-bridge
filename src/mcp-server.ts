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
// CAPABILITY GATE: pi.invokeTool is NOT upstream pi (local patch, see
// docs/PI-INVOOKETOOL-PATCH.md). If absent, startMcpServer returns { ok:false }
// and the bridge runs unchanged.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

/** Tools we do NOT expose to agy: it would just error (the provider is already
 *  antigravity, so the tool's own guard refuses; advertising it is noise). */
const SKIP_CIRCULAR = new Set(["AskAntigravity"]);

const BRIDGE_MCP_KEY = "pi-antigravity-bridge";
const TOKEN_HEADER = "x-bridge-token";
const MAX_BODY_BYTES = 1_000_000;

export interface McpServerHandle {
	port: number;
	close: () => Promise<void>;
}

export interface McpStartResult {
	ok: boolean;
	port?: number;
	handle?: McpServerHandle;
	reason?: string;
}

/** True only if the running pi exposes the local invokeTool patch. */
export function hasInvokeTool(pi: ExtensionAPI): boolean {
	return typeof (pi as unknown as { invokeTool?: unknown }).invokeTool === "function";
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

interface PiToolMeta {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { source?: string };
}

interface InvokeResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
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
	pi: ExtensionAPI,
	opts: { preferredPort?: number; log?: (s: string, d?: unknown) => void } = {},
): Promise<McpStartResult> {
	const log = opts.log ?? (() => {});

	if (!hasInvokeTool(pi)) {
		const reason =
			"pi.invokeTool unavailable (needs the local pi patch). MCP tool bridge disabled; provider and AskAntigravity tool run unchanged.";
		log("capability-missing", reason);
		return { ok: false, reason };
	}

	const getAll = (pi as unknown as { getAllTools: () => PiToolMeta[] }).getAllTools.bind(pi);
	const invoke =
		(pi as unknown as { invokeTool: (n: string, a?: unknown, o?: { signal?: AbortSignal }) => Promise<InvokeResult> }).invokeTool.bind(pi);

	const listHandler = async () => {
		const all = getAll();
		const tools = all
			.filter((t) => t.sourceInfo?.source !== "builtin")
			.filter((t) => !SKIP_CIRCULAR.has(t.name))
			.map((t) => {
				let inputSchema: object | undefined;
				try {
					inputSchema = t.parameters ? JSON.parse(JSON.stringify(t.parameters)) : undefined;
				} catch {
					inputSchema = { type: "object", properties: {}, additionalProperties: true };
				}
				return { name: t.name, description: t.description ?? t.name, inputSchema };
			});
		log("list-tools", { count: tools.length });
		return { tools };
	};

	const callHandler = async (request: { params: { name: string; arguments?: unknown } }, signal?: AbortSignal) => {
		const { name, arguments: args } = request.params;
		log("call-tool", { name });
		try {
			const r = await invoke(name, args ?? {}, { signal });
			const content =
				r.content && r.content.length > 0 ? r.content : [{ type: "text", text: JSON.stringify(r) }];
			log("call-tool-ok", { name });
			return { content, isError: r.isError ?? false };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log("call-tool-fail", { name, msg });
			return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
		}
	};

	const makeServer = (signal: AbortSignal) => {
		const s = new Server(
			{ name: "pi-antigravity-bridge", version: "0.1.0" },
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
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				// #3: require the shared-secret header. Constant-time compare so a
				// timing oracle can't recover the token byte-by-byte.
				const received = req.headers[TOKEN_HEADER];
				if (
					typeof received !== "string" ||
					received.length !== token.length ||
					!crypto.timingSafeEqual(Buffer.from(received), Buffer.from(token))
				) {
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
					close: async () => {
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
