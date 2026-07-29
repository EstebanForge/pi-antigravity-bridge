// Discover the agy conversation id that `agy -p` creates but never prints.
//
// agy's print mode writes its steps to a fresh SQLite DB at
// ~/.gemini/antigravity-cli/conversations/<uuid>.db. It does NOT echo the id.
// The only reliable bind is to snapshot the *.db stems in that dir before
// spawn, then diff after: exactly one new file = ours. If several appear we
// refuse to bind (can't tell which is ours)  -  same approach as antigravity-acp
// (scan.ts), agy-acp (scan.ts), and pi-ask-antigravity.
//
// CONCURRENCY: when another agy (or subagent) starts in parallel, more than
// one new .db can land in the dir during our turn. mtime filtering does NOT
// disambiguate two *active* concurrent runs (both DBs are >= turn-start), and
// prompt-content matching is fragile (the user-message step_type 98 payload
// is undocumented and deeply nested; a field-number shift would silently
// misbind). The authoritative signal is which candidate .db OUR spawned agy
// process tree holds open right now  -  resolved via /proc/<pid>/fd on Linux.
// When that signal is unavailable (no pid, non-Linux, process already exited,
// or the scan itself is ambiguous) we fail safe to null, preserving the
// original "refuse to bind" behavior rather than guessing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default conversations dir. Override with AGY_CONVERSATIONS_DIR. */
export const CONVERSATIONS_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

/** Snapshot the set of conversation ids (*.db stems) currently on disk.
 *  Empty set (not throw) when the dir is missing  -  agy will create it. */
export function snapshotConversations(dir: string = CONVERSATIONS_DIR): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const f of entries) {
		if (f.endsWith(".db")) out.add(f.slice(0, -3));
	}
	return out;
}

/** Resolve which of the `candidates` DB ids is held open by the process tree
 *  rooted at `rootPid`. Used to disambiguate concurrent agy runs.
 *
 *  Returns the single matching id, or null when none / several are open, when
 *  /proc is unavailable, or when reading fails. Injectable so tests can stub
 *  it without touching the filesystem. */
export type OpenDbResolver = (
	rootPid: number,
	dir: string,
	candidates: Set<string>,
) => string | null;

/** Read pid + ppid from /proc/<pid>/stat. Returns null when the entry is gone
 *  (process exited) or unparseable. comm may contain spaces and parens, so we
 *  split on the LAST ')' rather than naively tokenizing. */
function readProcStat(pid: number): { pid: number; ppid: number } | null {
	let raw: string;
	try {
		raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const closeParen = raw.lastIndexOf(")");
	if (closeParen < 0) return null;
	// After "pid (comm)" come: state ppid pgrp session ...
	const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
	const ppid = Number(fields[1]);
	if (!Number.isFinite(ppid)) return null;
	return { pid, ppid };
}

/** Collect rootPid and every descendant pid by walking /proc/<pid>/stat
 *  parent links. Single pass over /proc building a pid->ppid map, then
 *  iterated to closure. */
function collectDescendants(rootPid: number): Set<number> {
	const out = new Set<number>([rootPid]);
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return out;
	}
	const ppidOf = new Map<number, number>();
	for (const e of entries) {
		if (!/^\d+$/.test(e)) continue;
		const s = readProcStat(Number(e));
		if (s) ppidOf.set(s.pid, s.ppid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of ppidOf) {
			if (out.has(pid)) continue;
			if (out.has(ppid)) {
				out.add(pid);
				changed = true;
			}
		}
	}
	return out;
}

/** Linux /proc implementation of OpenDbResolver. Scans every FD symlink in
 *  the root process's tree and returns the one candidate .db that is open.
 *  Non-authoritative when zero or >1 candidates are open  -  caller fails safe. */
export const procTreeOpenDbResolver: OpenDbResolver = (rootPid, dir, candidates) => {
	if (candidates.size <= 1) return null; // nothing to disambiguate
	if (process.platform !== "linux") return null; // /proc/<pid>/fd is Linux-only
	const dirResolved = safeRealpath(dir);
	const tree = collectDescendants(rootPid);
	const found = new Set<string>();
	for (const pid of tree) {
		let fds: string[];
		try {
			fds = fs.readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue; // process gone or fd dir unreadable
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			// agy also holds .db-wal / .db-shm open; only the base .db matters.
			const base = path.basename(target);
			if (!base.endsWith(".db")) continue;
			if (dirResolved && safeRealpath(path.dirname(target)) !== dirResolved) continue;
			const id = base.slice(0, -3);
			if (candidates.has(id)) found.add(id);
		}
	}
	if (found.size === 1) return [...found][0] ?? null;
	return null;
};

/** fs.realpathSync that swallows ENOENT (dir may not be canonicalized yet). */
function safeRealpath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/** Options for {@link newConversationId}. */
export interface BindOptions {
	/** Pid of the spawned agy (the process we want to bind to). When set and
	 *  multiple candidate DBs exist, the process-tree FD resolver tries to
	 *  pick ours. Omit to keep the legacy fail-safe behavior. */
	pid?: number;
	/** Override resolver (tests). Defaults to the Linux /proc scanner. */
	resolveOpenDb?: OpenDbResolver;
	/** Invoked when the snapshot is ambiguous (more than one new DB since
	 *  `before`) and the resolver could not authoritatively pick ours. Lets a
	 *  caller bound its retry budget to the genuinely-ambiguous case only, so
	 *  the ordinary "agy hasn't created its DB yet" wait is not counted
	 *  against it. Not invoked when there is nothing new yet, or when exactly
	 *  one new DB binds, or when the resolver succeeds. */
	onAmbiguous?: () => void;
}

/** Find the conversation id created since `before`. Returns null when none
 *  appeared, or when several appeared and we cannot authoritatively tie one
 *  to our process. Pass `opts.pid` to enable concurrent-run disambiguation. */
export function newConversationId(
	dir: string,
	before: Set<string>,
	opts: BindOptions = {},
): string | null {
	const after = snapshotConversations(dir);
	const created = [...after].filter((id) => !before.has(id));
	if (created.length === 0) return null;
	if (created.length === 1) return created[0] ?? null;
	// Ambiguous: more than one new DB since the snapshot. Try to authoritatively
	// identify ours via the spawned process's open files. Fail safe to null
	// (refuse to bind) when the resolver can't pick exactly one.
	if (opts.pid !== undefined) {
		const resolve = opts.resolveOpenDb ?? procTreeOpenDbResolver;
		const hit = resolve(opts.pid, dir, new Set(created));
		if (hit && created.includes(hit)) return hit;
	}
	opts.onAmbiguous?.();
	return null;
}

/** Path to the DB file for a given conversation id. */
export function conversationDbPath(
	id: string,
	dir: string = CONVERSATIONS_DIR,
): string {
	return path.join(dir, `${id}.db`);
}
