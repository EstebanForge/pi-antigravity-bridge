// Daily NDJSON debug log for support and post-mortems.
//
// One file per local day: <dir>/YYYY-MM-DD.ndjson, one JSON record per line.
// Everything the extension logs (driver lifecycle, bridge traffic, round
// trips, turn outcomes, /agy commands) lands here so a broken session can be
// replayed from disk instead of from a user's memory. Users attach the last
// days' files when reporting issues.
//
// Hard rules (learned from the pi-token-cost-ledger writer):
//   - Never throw, never await in the hot path. Logging must never disrupt
//     a turn; a broken/unwritable dir is swallowed.
//   - One appendFile per record: O_APPEND keeps single-line writes atomic,
//     so two pi tabs sharing the dir stay line-consistent.
//   - No secrets, no prompt content: values of secret-shaped keys are
//     redacted and long strings are truncated before they reach disk.
//   - Retention: files older than `retentionDays` are pruned once per
//     process, so the dir cannot grow unbounded.
//   - Two tiers, to keep SSD wear negligible for regular users: only
//     info/warn/error records (failures, turn/tool boundaries, commands,
//     setup) are written by default. Full verbose trails (per-event driver
//     lifecycle, raw bridge traffic) require AGY_DEBUG=1.

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DailyLoggerOptions {
	/** Target directory (created on first write). */
	dir: string;
	/** Files older than this many days are pruned once per process. Default 14. */
	retentionDays?: number;
	/** Verbose gate. When false (default), debug-level records are dropped:
	 *  only info/warn/error land on disk, the light stream regular users
	 *  keep. AGY_DEBUG=1 (or this option) restores the full trail. */
	debug?: boolean;
	/** Injectable clock for tests. */
	now?: () => Date;
}

export interface DailyLogger {
	log(event: string, data?: unknown, level?: LogLevel): void;
	/** Resolves when every queued write settled (tests, shutdown). */
	flush(): Promise<void>;
	readonly dir: string;
	/** Path of the file the next record lands in (doctor display). */
	todayPath(): string;
}

/** Local-date key, lexicographically sortable: 2026-02-05. */
function dayKey(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MAX_STRING = 2000;
const MAX_DEPTH = 6;
/** Cap for one serialized line: keeps the O_APPEND atomic-write guarantee
 *  honest for PIPE_BUF-sized writes even when many capped fields combine. */
const MAX_RECORD = 4000;
// Key-name redaction. `headers` is included wholesale: MCP server configs
// carry auth material under headers[] ({name, value} pairs) and the token
// lives in `value`, which a name-only regex would miss.
const SECRET_KEY = /token|secret|password|passphrase|authorization|api[-_]?key|cookie|headers/i;

/** Redact secret-shaped values and cap runaway strings before disk. */
function scrub(value: unknown, depth: number): unknown {
	if (value === null || value === undefined) return value;
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: scrub(value.stack, depth) };
	}
	if (typeof value === "string") {
		return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…(truncated)" : value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= MAX_DEPTH) return "(depth limit)";
	if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
		}
		return out;
	}
	return String(value);
}

/** Matches the truthy set used across the extension's env parsing. */
function isEnvTruthy(v: string | undefined): boolean {
	return v !== undefined && ["1", "true", "on"].includes(v.toLowerCase());
}

export function createDailyLogger(opts: DailyLoggerOptions): DailyLogger {
	const dir = opts.dir;
	const retentionDays = opts.retentionDays ?? 14;
	const verbose = opts.debug ?? isEnvTruthy(process.env.AGY_DEBUG);
	const now = opts.now ?? (() => new Date());
	// Serialized write chain: keeps day-rotation (mkdir + prune) ordered
	// ahead of the records that triggered it. Volume is lifecycle-events
	// low, so chaining costs nothing.
	let chain: Promise<void> = Promise.resolve();
	let ensuredDay = "";
	let pruned = false;

	async function prune(): Promise<void> {
		if (pruned) return;
		pruned = true;
		const cutoff = dayKey(new Date(now().getTime() - retentionDays * 86_400_000));
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (!name.endsWith(".ndjson")) continue;
			if (name.slice(0, 10) >= cutoff) continue;
			await unlink(path.join(dir, name)).catch(() => {
				/* in use or gone: keep the rest */
			});
		}
	}

	function write(level: LogLevel, event: string, data: unknown): void {
		const d = now();
		const day = dayKey(d);
		// Build the line outside the chain but guarded: scrub()/stringify run
		// synchronously in log(), and a throwing getter in a future caller's
		// data must not break the never-throw contract.
		let line: string;
		try {
			const record: Record<string, unknown> = {
				ts: d.toISOString(),
				level,
				event,
			};
			if (data !== undefined) record.data = scrub(data, 0);
			line = JSON.stringify(record);
			if (line.length > MAX_RECORD) {
				record.data = `(record exceeded ${MAX_RECORD} bytes; payload dropped)`;
				line = JSON.stringify(record);
			}
			line += "\n";
		} catch {
			line = `${JSON.stringify({ ts: d.toISOString(), level, event, data: "(unserializable)" })}\n`;
		}
		// Single chained task per record: an append failure retries ONCE inside
		// the same task (day gate reset -> recursive mkdir rebuild -> append
		// again). flush() therefore always waits past the retry, and a
		// persistent failure costs at most two fs attempts, never a loop.
		chain = chain.then(async () => {
			try {
				if (ensuredDay !== day) {
					await mkdir(dir, { recursive: true });
					ensuredDay = day;
					await prune();
				}
				await appendFile(path.join(dir, `${day}.ndjson`), line, "utf8");
			} catch {
				try {
					ensuredDay = "";
					await mkdir(dir, { recursive: true });
					ensuredDay = day;
					await appendFile(path.join(dir, `${day}.ndjson`), line, "utf8");
				} catch {
					/* swallow: an unwritable dir must not disrupt the chat */
				}
			}
		});
	}

	return {
		log(event, data, level = "debug") {
			// Volume gate: debug is the verbose tier. Default installs write
			// only info/warn/error so the disk cost stays negligible.
			if (level === "debug" && !verbose) return;
			write(level, event, data);
		},
		flush() {
			return chain.catch(() => {});
		},
		dir,
		todayPath() {
			return path.join(dir, `${dayKey(now())}.ndjson`);
		},
	};
}
