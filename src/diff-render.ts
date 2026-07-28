// G8: surface agy's file edits as a diff in pi's thinking stream.
//
// agy edits with its OWN native `write_to_file` (full-file content), inside a
// closed tool loop that lands changes on disk. pi's native colored diff viewer
// is unreachable for agy turns (it is part of the tool-call lifecycle, and the
// provider emits no toolCall blocks by design), so we compute a line-numbered
// diff ourselves and stream it as text through the thinking channel, reusing
// pi's own `generateDiffString` for an identical format.
//
// OLD content comes from git (the committed version), resolved PER FILE so
// nested repos / submodules / multi-repo workspaces each diff against their
// own HEAD. A turn-scoped cache makes multi-edit-same-file turns diff
// incrementally instead of cumulatively. Off-repo / untracked / binary files
// degrade to a one-line summary. See docs/PI-BRIDGE-GAPS.md (G8).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { generateDiffString } from "@earendil-works/pi-coding-agent";

/** Maximum diff lines emitted for one edit before truncation. */
export const DEFAULT_MAX_DIFF_LINES = 100;

/** Injectable git operations so the pure logic is unit-testable without a
 *  real repo. `toplevel` returns null when the dir is not inside a git work
 *  tree; `showHead` returns null when the path is untracked / absent from HEAD. */
export interface GitOps {
	toplevel(fileDir: string): string | null;
	showHead(toplevel: string, relPath: string): string | null;
}

/** Default git ops via synchronous git CLI calls. Cheap; one process per call. */
export function createExecGitOps(): GitOps {
	const run = (args: string[], cwd: string): string | null => {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return null;
		}
	};
	return {
		toplevel: (fileDir) => {
			const t = run(["rev-parse", "--show-toplevel"], fileDir);
			return t ? t.trim() || null : null;
		},
		showHead: (toplevel, relPath) => run(["show", `HEAD:${relPath}`], toplevel),
	};
}

export type EditDiffKind = "diff" | "summary" | "binary" | "none";

export interface EditDiffOutcome {
	kind: EditDiffKind;
	/** Text to append after the edit label in the thinking stream. Empty for
	 *  `none` (nothing to show). */
	text: string;
}

/** A parsed agy edit-tool invocation: a file path plus its full new content.
 *  Detected generically by key name so future agy edit-tool variants work
 *  without hardcoding tool names. */
export interface ParsedEdit {
	/** File path as agy wrote it (absolute or cwd-relative). */
	file: string;
	content: string;
	description?: string;
}

/** True if the string looks like binary (contains a NUL byte). Mirrors git's
 *  own heuristic; avoids feeding binary into the line differ. */
function isBinary(s: string): boolean {
	return s.includes("\u0000");
}

/** Parse an agy tool-call inputJson into an edit if it carries both a
 *  file-path-like and a content-like string field. Returns null for non-edits
 *  (reads, greps, malformed JSON, missing fields). */
export function parseEditToolInput(inputJson: string): ParsedEdit | null {
	if (!inputJson) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(inputJson);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	let file = "";
	let content = "";
	let description: string | undefined;
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v !== "string") continue;
		if (!file && /(^|_)?(file|path)$/i.test(k)) file = v;
		else if (!content && /content|code/i.test(k)) content = v;
		else if (!description && /description|toolaction|toolsummary/i.test(k)) description = v;
	}
	if (!file || !content) return null;
	return { file, content, description };
}

/** Turn-scoped diff context. Holds the OLD-content cache (so the 2nd edit to
 *  the same file in a turn diffs against the 1st edit's result, not HEAD again)
 *  and a toplevel cache (one `rev-parse` per edited directory per turn).
 *  Create one fresh per turn so concurrent turns never share state. */
export class TurnDiffContext {
	private readonly oldCache = new Map<string, string>();
	private readonly toplevelCache = new Map<string, string | null>();
	private readonly seenFiles = new Set<string>();

	constructor(
		private readonly git: GitOps,
		private readonly maxDiffLines: number = DEFAULT_MAX_DIFF_LINES,
	) {}

	/** Compute the diff (or summary) for one edit. `absFile` must be absolute. */
	diffEdit(absFile: string, newContent: string): EditDiffOutcome {
		// Binary short-circuit before any git work.
		if (isBinary(newContent)) {
			this.oldCache.set(absFile, newContent);
			return { kind: "binary", text: "(binary file; diff skipped)" };
		}

		const dir = path.dirname(absFile);
		let toplevel = this.toplevelCache.get(dir);
		if (toplevel === undefined) {
			toplevel = this.git.toplevel(dir);
			this.toplevelCache.set(dir, toplevel);
		}

		// Not inside any git repo: no OLD baseline available without a pre-turn
		// snapshot (approach C, deferred). Degrade to a one-line summary.
		if (!toplevel) {
			this.oldCache.set(absFile, newContent);
			return {
				kind: "summary",
				text: `(${countLines(newContent)} lines; not in a git repo, no diff)`,
			};
		}

		const relPath = path.relative(toplevel, absFile);
		// File lives outside its resolved repo (e.g. agy edited something under a
		// sibling tree). Treat like off-repo: summary, no diff.
		if (relPath.startsWith("..")) {
			this.oldCache.set(absFile, newContent);
			return {
				kind: "summary",
				text: `(${countLines(newContent)} lines; outside the git repo, no diff)`,
			};
		}

		// OLD baseline: the prior edit's result if we've seen this file this
		// turn, else the committed version (untracked/new file -> empty string).
		let oldContent: string;
		if (this.seenFiles.has(absFile) && this.oldCache.has(absFile)) {
			oldContent = this.oldCache.get(absFile) ?? "";
		} else {
			const committed = this.git.showHead(toplevel, relPath);
			oldContent = committed ?? "";
		}
		this.seenFiles.add(absFile);
		this.oldCache.set(absFile, newContent);

		if (isBinary(oldContent)) {
			return { kind: "binary", text: "(was binary; diff skipped)" };
		}
		if (oldContent === newContent) {
			return { kind: "none", text: "" };
		}

		const { diff } = generateDiffString(oldContent, newContent);
		return { kind: "diff", text: capLines(diff, this.maxDiffLines) };
	}
}

function countLines(s: string): number {
	if (s.length === 0) return 0;
	return s.split("\n").length;
}

/** Truncate a diff to at most `max` lines, keeping the head and noting how many
 *  were dropped. A diff's changes are interspersed, so head-first is fine. */
function capLines(diff: string, max: number): string {
	if (max <= 0) return diff;
	const lines = diff.split("\n");
	if (lines.length <= max) return diff;
	const dropped = lines.length - max;
	return `${lines.slice(0, max).join("\n")}\n[... ${dropped} more diff lines]`;
}
