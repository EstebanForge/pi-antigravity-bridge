import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ACP server hands the Google OAuth URL ONLY to the browser-open call:
// nothing on stdout or stderr, headless or not (verified per
// docs/ACP-PROTOCOL-REFERENCE.md). The capture makes the URL visible:
// BROWSER points at a wrapper that appends the URL to a record file and then
// execs the real opener, and the connection watches the record file to log
// "auth-url". Local users keep the automatic browser open; over SSH the user
// copies the URL and forwards the redirect port.

export interface AuthUrlCapture {
	/** Spawn env for the ACP server (BROWSER -> wrapper script). */
	browserEnv: Record<string, string>;
	/** Record file the connection watches. */
	file: string;
	/** Most recent URL in the record file, or null. */
	lastUrl(): string | null;
}

/** First existing executable named `name` on `env.PATH`, or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			const st = fs.statSync(candidate);
			if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
		} catch {
			/* not here */
		}
	}
	return null;
}

/** Last http(s) line of `file`, or null (absent/unreadable counts as empty). */
export function readLastUrl(file: string): string | null {
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => /^https?:\/\//.test(l));
		return lines.at(-1) ?? null;
	} catch {
		return null;
	}
}

/** Port of the OAuth loopback redirect (redirect_uri param), or null. */
export function parseAuthPort(url: string): number | null {
	try {
		const redirect = new URL(url).searchParams.get("redirect_uri");
		if (!redirect) return null;
		const port = new URL(redirect).port;
		return port ? Number(port) : null;
	} catch {
		return null;
	}
}

const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** Create the capture (record file + wrapper script) and return the spawn
 *  env. Idempotent: the wrapper is rewritten only when content changes. The
 *  opener to forward to is resolved once, at write time: an existing BROWSER
 *  wins, then xdg-open, then macOS open; with none available the wrapper
 *  records the URL and exits (headless: capture without an opener). The
 *  forward word-splits the BROWSER value, so flag forms (`open -a Chrome`)
 *  work; a BROWSER path containing spaces does not (rare, and BROWSER lists
 *  are not honored either - the first entry is what chains). Windows browser
 *  resolution differs; no capture there. */
export function setupAuthUrlCapture(dataDir = path.join(os.homedir(), ".pi", "agent", "antigravity-bridge"), env: NodeJS.ProcessEnv = process.env): AuthUrlCapture | null {
	if (process.platform === "win32") return null;
	const file = path.join(dataDir, "acp-auth-urls.log");
	const wrapper = path.join(dataDir, "acp-browser-wrapper.sh");
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		// Truncate: the file mirrors the current login attempt only. OAuth
		// URLs carry state + PKCE challenges, so keep the record private.
		fs.writeFileSync(file, "", { mode: 0o600 });
		const opener = env.BROWSER?.trim() || findOnPath("xdg-open", env) || findOnPath("open", env) || "";
		const body = [
			"#!/usr/bin/env sh",
			"# Antigravity bridge: records the Google OAuth URL the ACP server hands",
			"# to the browser, then forwards to the real opener. The bridge watches",
			"# the record file and shows the URL in pi (copy it when logging in over",
			"# SSH; forward the redirect port first).",
			`printf '%s\\n' "$@" >> ${shQuote(file)}`,
			`REAL=${shQuote(opener)}`,
			'if [ -n "$REAL" ]; then set -f; exec $REAL "$@"; fi',
			"",
		].join("\n");
		const write = (p: string, content: string, mode: number): void => {
			try {
				if (fs.readFileSync(p, "utf8") === content) return;
			} catch {
				/* new file */
			}
			fs.writeFileSync(p, content, { mode });
		};
		write(wrapper, body, 0o755);
		return { browserEnv: { BROWSER: wrapper }, file, lastUrl: () => readLastUrl(file) };
	} catch {
		return null; // capture is best effort; login still works without it
	}
}
