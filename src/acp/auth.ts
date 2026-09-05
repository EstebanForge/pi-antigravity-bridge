import { AcpConnection } from "./connection.js";

// Explicit sign-in (/agy auth): spawn a short-lived server, send
// `authenticate` (the RPC that fires the loopback listener + browser OAuth
// flow), and wait for the token to land in the shared acp_token.json. A
// dedicated process keeps the minutes-scale login ritual away from live
// turns; the next driver connection picks the token up. The real server
// blocks until the browser round-trip completes; the observed window is
// minutes-scale (one flow timed out at ~8.5 minutes), so the timeout is
// generous.

export const AUTH_TIMEOUT_MS = 10 * 60_000;

export interface AcpAuthOptions {
	bin: string;
	binArgs?: string[];
	cwd?: string;
	extraEnv?: Record<string, string>;
	authUrlFile?: string;
	timeoutMs?: number;
	log?: (msg: string, data?: unknown) => void;
}

export interface AcpAuthResult {
	ok: boolean;
	/** Failure reason (spawn, timeout, -32000 family). Absent when ok. */
	error?: string;
}

export function runAcpAuth(opts: AcpAuthOptions): Promise<AcpAuthResult> {
	const conn = new AcpConnection({
		bin: opts.bin,
		binArgs: opts.binArgs,
		cwd: opts.cwd ?? process.cwd(),
		extraEnv: opts.extraEnv,
		authUrlFile: opts.authUrlFile,
		log: opts.log ?? (() => {}),
		onUpdate: () => {},
		onExit: () => {},
	});
	return (async () => {
		try {
			await conn.start();
			await conn.request("authenticate", { methodId: "oauth-personal" }, opts.timeoutMs ?? AUTH_TIMEOUT_MS);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			conn.kill();
		}
	})();
}
