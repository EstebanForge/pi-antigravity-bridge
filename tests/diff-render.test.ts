// Unit tests for src/diff-render.ts (G8: agy edit diffs in the thinking stream).
//
// Pure logic exercised with a fake GitOps (no real repo needed); one real-git
// smoke validates the execFileSync wrapper. Run: npm test

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	TurnDiffContext,
	createExecGitOps,
	parseEditToolInput,
	type GitOps,
} from "../src/diff-render.js";

// --- fake git ---------------------------------------------------------------

interface FakeGit {
	ops: GitOps;
	calls: { toplevel: string[]; showHead: string[] };
}

/** Build a recording fake. `head` maps relPath -> committed content (null entry
 *  = untracked). `toplevel` is returned for every dir (null = not a repo). */
function fakeGit(toplevel: string | null, head: Record<string, string> = {}): FakeGit {
	const calls = { toplevel: [] as string[], showHead: [] as string[] };
	return {
		calls,
		ops: {
			toplevel: (dir) => {
				calls.toplevel.push(dir);
				return toplevel;
			},
			showHead: (_t, rel) => {
				calls.showHead.push(rel);
				return rel in head ? head[rel] : null;
			},
		},
	};
}

// --- parseEditToolInput -----------------------------------------------------

test("parseEditToolInput: write_to_file shape -> parsed", () => {
	const p = parseEditToolInput(
		JSON.stringify({
			TargetFile: "/repo/src/a.ts",
			CodeContent: "new body",
			Description: "rewrite a",
			Overwrite: true,
		}),
	);
	assert.equal(p?.file, "/repo/src/a.ts");
	assert.equal(p?.content, "new body");
	assert.equal(p?.description, "rewrite a");
});

test("parseEditToolInput: content/file keys detected generically", () => {
	const p = parseEditToolInput(JSON.stringify({ filePath: "x", fileContent: "y" }));
	assert.equal(p?.file, "x");
	assert.equal(p?.content, "y");
});

test("parseEditToolInput: read-only tools (no content key) -> null", () => {
	// view_file has a path but no content field
	assert.equal(
		parseEditToolInput(JSON.stringify({ AbsolutePath: "/repo/a", toolAction: "viewing" })),
		null,
	);
});

test("parseEditToolInput: malformed / empty -> null", () => {
	assert.equal(parseEditToolInput(""), null);
	assert.equal(parseEditToolInput("{not json"), null);
	assert.equal(parseEditToolInput(JSON.stringify({ noPath: "x" })), null);
});

// --- TurnDiffContext.diffEdit ----------------------------------------------

test("diffEdit: tracked file -> diff against committed HEAD", () => {
	const fg = fakeGit("/repo", { "src/a.ts": "line1\nline2\nline3" });
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/repo/src/a.ts", "line1\nCHANGED\nline3");
	assert.equal(out.kind, "diff");
	assert.match(out.text, /CHANGED/);
	assert.match(out.text, /line2/); // removed line present
	assert.equal(fg.calls.showHead.length, 1);
});

test("diffEdit: untracked / new file -> all-added diff (old empty)", () => {
	const fg = fakeGit("/repo", {}); // showHead returns null
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/repo/new.txt", "brand\nnew\nfile");
	assert.equal(out.kind, "diff");
	assert.match(out.text, /brand/);
});

test("diffEdit: not in a git repo -> one-line summary, no git show", () => {
	const fg = fakeGit(null);
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/plain/dir/f.txt", "some\ncontent");
	assert.equal(out.kind, "summary");
	assert.match(out.text, /not in a git repo/);
	assert.equal(fg.calls.showHead.length, 0);
});

test("diffEdit: file outside its resolved repo -> summary", () => {
	// toplevel resolves to /repo but the file is under /elsewhere
	const fg = fakeGit("/repo");
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/elsewhere/f.txt", "x\n");
	assert.equal(out.kind, "summary");
	assert.match(out.text, /outside the git repo/);
});

test("diffEdit: binary new content -> binary skip", () => {
	const fg = fakeGit("/repo", { "b.dat": "old" });
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/repo/b.dat", "abc\u0000def");
	assert.equal(out.kind, "binary");
	assert.match(out.text, /binary/);
});

test("diffEdit: identical content -> none", () => {
	const fg = fakeGit("/repo", { "f.txt": "same" });
	const ctx = new TurnDiffContext(fg.ops);
	const out = ctx.diffEdit("/repo/f.txt", "same");
	assert.equal(out.kind, "none");
	assert.equal(out.text, "");
});

test("diffEdit: multi-edit same file in one turn is incremental (cache, git once)", () => {
	const fg = fakeGit("/repo", { "f.txt": "v1" });
	const ctx = new TurnDiffContext(fg.ops);
	const first = ctx.diffEdit("/repo/f.txt", "v2");
	assert.match(first.text, /v2/);
	const second = ctx.diffEdit("/repo/f.txt", "v3");
	// second diff is v2 -> v3, NOT v1 -> v3, and showHead was called only once
	assert.equal(fg.calls.showHead.length, 1);
	assert.match(second.text, /v3/);
});

test("diffEdit: line cap truncates with a marker", () => {
	const fg = fakeGit("/repo", {}); // untracked -> all-added
	const ctx = new TurnDiffContext(fg.ops, 10);
	const many = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
	const out = ctx.diffEdit("/repo/big.txt", many);
	assert.equal(out.kind, "diff");
	assert.match(out.text, /\[\.\.\. \d+ more diff lines\]/);
});

// --- createExecGitOps: real-git smoke ---------------------------------------

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

test("createExecGitOps: toplevel + showHead against a real temp repo", () => {
	if (!gitAvailable()) return;
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-diff-"));
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
		run(["init", "-q"]);
		run(["config", "user.email", "t@t"]);
		run(["config", "user.name", "t"]);
		fs.writeFileSync(path.join(repo, "committed.txt"), "old\nbody\n");
		run(["add", "committed.txt"]);
		run(["commit", "-q", "-m", "init"]);
		fs.writeFileSync(path.join(repo, "untracked.txt"), "new");

		const git = createExecGitOps();
		assert.equal(git.toplevel(repo), repo);
		assert.equal(git.showHead(repo, "committed.txt"), "old\nbody\n");
		assert.equal(git.showHead(repo, "untracked.txt"), null); // not in HEAD
		assert.equal(git.toplevel(os.tmpdir()) === repo, false); // tmpdir is not this repo
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
