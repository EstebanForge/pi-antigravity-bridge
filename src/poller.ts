// Read-only poller over an agy conversation SQLite DB.
//
// Opens ~/.gemini/antigravity-cli/conversations/<uuid>.db read-only and reads
// newly-appended rows from the `steps` table on each poll. Uses node:sqlite
// (built into Node >= 22.5; this machine is 26.5.0) so there is no native
// dependency to ship. The caller drives a 250ms poll loop.
//
// Coalescing: agy's writer commits through its own connection, so we use
// SQLite's `PRAGMA data_version` to skip the SELECT when nothing has changed
// since the last poll (agy-acp pattern). data_version bumps on every commit
// by another connection  -  cheap and exact.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { toUint8 } from "./protobuf.js";

/** A raw step row as read from the DB. payload is the undecoded step_payload
 *  BLOB; callers pass it to the protobuf extractor. */
export interface Step {
	idx: number;
	stepType: number;
	status: number;
	payload: Uint8Array;
}

const SELECT_STEPS =
	"SELECT idx, step_type, status, step_payload FROM steps WHERE idx > ? ORDER BY idx";
const SELECT_STEP_AT =
	"SELECT idx, step_type, status, step_payload FROM steps WHERE idx = ?";

const HAS_STEPS =
	"SELECT COUNT(*) > 0 AS present FROM sqlite_master WHERE type='table' AND name='steps'";

/** Open the DB read-only. Returns null when the file doesn't exist yet or
 *  lacks a steps table (agy hasn't created/flushed it). Throws are swallowed
 *  so a transient lock or half-written file is retried on the next poll. */
function openReadOnly(dbPath: string): DatabaseSync | null {
	if (!fs.existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db.prepare(HAS_STEPS).get() as { present?: number } | undefined;
		if (!row?.present) {
			db.close();
			return null;
		}
		return db;
	} catch {
		return null;
	}
}

/** A reusable read handle on one conversation's steps table.
 *
 * Keeps one DB connection + prepared statement open for the life of a turn,
 * so the poll loop isn't re-opening the file each tick. `poll()` returns only
 * rows newer than the last one seen, advancing an internal cursor.
 *
 * A row whose payload fails to materialize (torn read while agy is mid-write)
 * is dropped, not thrown  -  its idx is NOT advanced past, so it's retried on
 * the next poll once the write settles. (agy-acp database.ts pattern.) */
export class ConversationPoller {

	private db: DatabaseSync | null = null;
	private selectStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
	private selectAtStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
	private dataVersionStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
	private lastDataVersion: number | null = null;
	private _lastIdx: number;

	constructor(
		private readonly dbPath: string,
		baseStepIdx = -1,
	) {
		this._lastIdx = baseStepIdx;
		this.db = openReadOnly(dbPath);
		if (this.db) {
			this.selectStmt = this.db.prepare(SELECT_STEPS);
			this.selectAtStmt = this.db.prepare(SELECT_STEP_AT);
			this.dataVersionStmt = this.db.prepare("PRAGMA data_version");
		}
	}

	/** True if the DB was openable at construction. False means agy hasn't
	 *  created/flushed it yet  -  call tryOpen() on later polls. */
	get isOpen(): boolean {
		return this.db !== null;
	}

	/** The highest idx seen (or the base passed at construction). Persist this
	 *  across turns so a resumed conversation only streams new steps. */
	get lastIdx(): number {
		return this._lastIdx;
	}

	/** Retry opening the DB if it wasn't ready at construction. Returns the
	 *  new open state. Idempotent. */
	tryOpen(): boolean {
		if (this.db) return true;
		this.db = openReadOnly(this.dbPath);
		if (this.db) {
			this.selectStmt = this.db.prepare(SELECT_STEPS);
			this.selectAtStmt = this.db.prepare(SELECT_STEP_AT);
			this.dataVersionStmt = this.db.prepare("PRAGMA data_version");
			return true;
		}
		return false;
	}

	/** Returns true when another connection has committed since the last poll.
	 *  When false, readNewSteps() and poll() are guaranteed to return [] and can
	 *  be skipped. Call ONCE per tick: it advances the data_version cursor, so a
	 *  second call in the same tick sees no change. Exposed so the runner can
	 *  gate its in-place step re-read (readStepAt) behind the same check and
	 *  avoid a redundant SELECT every idle tick while agy is thinking. */
	hasChanged(): boolean {
		if (!this.db || !this.dataVersionStmt) return true; // force a read on first poll
		const row = this.dataVersionStmt.get() as { data_version?: number } | undefined;
		const v = row?.data_version ?? 0;
		if (this.lastDataVersion === null) {
			this.lastDataVersion = v;
			return true;
		}
		if (v === this.lastDataVersion) return false;
		this.lastDataVersion = v;
		return true;
	}

	/** Read new steps since the last call WITHOUT re-checking data_version.
	 *  The caller gates this behind hasChanged() so the SELECT only fires when a
	 *  commit actually landed. Returns [] when the DB isn't open or has no new
	 *  rows. Advances the cursor past every successfully-read row. */
	readNewSteps(): Step[] {
		if (!this.db || !this.selectStmt) return [];
		const rows = this.selectStmt.all(this._lastIdx) as Array<{
			idx: number;
			step_type: number;
			status: number;
			step_payload: unknown;
		}>;
		const out: Step[] = [];
		let advanced = this._lastIdx;
		for (const r of rows) {
			try {
				out.push({
					idx: r.idx,
					stepType: r.step_type,
					status: r.status,
					payload: toUint8(r.step_payload),
				});
				advanced = r.idx;
			} catch {
				// Torn read: drop this row, do not advance. Retried next poll.
				break;
			}
		}
		this._lastIdx = Math.max(this._lastIdx, advanced);
		return out;
	}

	/** Convenience: hasChanged() + readNewSteps() in one call. Kept for the
	 *  decode-db diagnostic and any caller that doesn't need the separate
	 *  in-place re-read. */
	poll(): Step[] {
		return this.hasChanged() ? this.readNewSteps() : [];
	}

	/** Read a single step by idx without advancing the cursor. Used to re-check
	 *  the last text/thinking step: agy extends the step it is currently writing
	 *  in place (same idx, growing text), and poll() only returns idx > lastIdx. */
	readStepAt(idx: number): Step | null {
		if (!this.db || !this.selectAtStmt) return null;
		let row;
		try {
			row = this.selectAtStmt.get(idx) as
				| { idx: number; step_type: number; status: number; step_payload: unknown }
				| undefined;
		} catch {
			return null;
		}
		if (!row) return null;
		try {
			return {
				idx: row.idx,
				stepType: row.step_type,
				status: row.status,
				payload: toUint8(row.step_payload),
			};
		} catch {
			return null;
		}
	}

	/** Release the DB handle. Safe to call multiple times. */
	close(): void {
		try {
			this.db?.close();
		} catch {
			// already closed
		}
		this.db = null;
	}
}
