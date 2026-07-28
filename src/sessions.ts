// Persisted map: pi session key -> agy conversation id + last streamed step.
//
// agy holds its own conversation history in the DB keyed by conversation id.
// To resume a multi-turn pi conversation, we thread the same agy id across
// streamSimple calls and skip steps we already streamed last turn.
//
// The key is options.sessionId when pi provides it, else the cwd (single-
// conversation-per-process fallback). Stored at
// ~/.pi/agent/antigravity-bridge/sessions.json with atomic rename.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"antigravity-bridge",
	"sessions.json",
);

export interface AgySession {
	conversationId: string;
	lastStepIdx: number;
	/** pi context.messages length captured at the start of the last agy turn.
	 *  Used by the provider to compute a delta digest of pi-side context agy
	 *  was not spawned for (compaction summaries, other-provider turns). 0 on a
	 *  fresh or pre-watermark session. Optional for backward compat with older
	 *  persisted sessions that predate the watermark. */
	lastMessageCount?: number;
}

type StoreMap = Record<string, AgySession>;

/** Narrow untrusted parsed JSON into a clean StoreMap, validating each entry's
 *  shape instead of trusting the whole structure (the cast previously let a
 *  hand-edited or corrupt file plant wrong-typed fields into the cache).
 *  Drops any entry whose `conversationId` isn't a string; falls back to -1 when
 *  `lastStepIdx` is missing or not a finite number. Returns {} for non-object
 *  input. */
function narrowStoreMap(parsed: unknown): StoreMap {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const clean: StoreMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const conversationId = (value as { conversationId?: unknown }).conversationId;
		if (typeof conversationId !== "string") continue;
		const idx = (value as { lastStepIdx?: unknown }).lastStepIdx;
		const mc = (value as { lastMessageCount?: unknown }).lastMessageCount;
		clean[key] = {
			conversationId,
			lastStepIdx: typeof idx === "number" && Number.isFinite(idx) ? idx : -1,
			lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
		};
	}
	return clean;
}

/** Atomic-write JSON session store. Writes are serialized through a promise
 *  chain so two concurrent turns can't interleave renames.
 *
 *  Multi-process safety: persist() re-reads the file fresh and overlays only
 *  the keys this instance has dirtied since load, so two pi processes editing
 *  different sessions never clobber each other. (Whole-file overwrite from a
 *  stale in-memory snapshot was the previous behavior  -  last writer won.) */
export class SessionStore {
	private readonly path: string;
	private cache: StoreMap = {};
	private readonly dirty = new Set<string>();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(storePath: string = STORE_PATH) {
		this.path = storePath;
		this.load();
	}

	private load(): void {
		try {
			const raw = fs.readFileSync(this.path, "utf8");
			this.cache = narrowStoreMap(JSON.parse(raw));
		} catch {
			// missing or corrupt  -  start empty. The first set() will create it.
			this.cache = {};
		}
	}

	get(key: string): AgySession | null {
		const s = this.cache[key];
		if (!s || typeof s.conversationId !== "string") return null;
		return {
			conversationId: s.conversationId,
			lastStepIdx: s.lastStepIdx ?? -1,
			lastMessageCount: s.lastMessageCount ?? 0,
		};
	}

	/** Update one session and persist atomically (temp file + rename). The
	 *  write is queued; callers don't need to await it. */
	set(key: string, session: AgySession): void {
		this.cache[key] = session;
		this.dirty.add(key);
		// Serialize through a chain so concurrent sets don't interleave renames.
		this.writeChain = this.writeChain
			.then(() => this.persist())
			.catch(() => {
				/* swallow; next set() retries */
			});
	}

	private async persist(): Promise<void> {
		const dir = path.dirname(this.path);
		await fs.promises.mkdir(dir, { recursive: true });

		// Re-read the current file so we merge against the latest on-disk state,
		// not our possibly-stale in-memory snapshot. Overlay only OUR dirty keys
		// so a concurrent process's writes to other keys survive.
		let disk: StoreMap = {};
		try {
			const raw = await fs.promises.readFile(this.path, "utf8");
			disk = narrowStoreMap(JSON.parse(raw));
		} catch {
			/* missing or corrupt  -  start from empty */
		}
		const merged: StoreMap = { ...disk };
		for (const key of this.dirty) {
			merged[key] = this.cache[key];
		}

		const tmp = `${this.path}.${process.pid}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", {
			mode: 0o600,
		});
		await fs.promises.rename(tmp, this.path);
		this.dirty.clear();
	}

	/** Wipe all session bindings (forces fresh agy conversations on every
	 *  active session). Used by the /agy clear command. */
	clear(): void {
		this.cache = {};
		this.dirty.clear();
		this.writeChain = this.writeChain
			.then(async () => {
				const tmp = `${this.path}.${process.pid}.tmp`;
				await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
				await fs.promises.writeFile(tmp, "{}\n", { mode: 0o600 });
				await fs.promises.rename(tmp, this.path);
			})
			.catch(() => {
				/* swallow; user can retry */
			});
	}

	/** Count persisted session bindings (for status display). */
	get size(): number {
		return Object.keys(this.cache).length;
	}
}
