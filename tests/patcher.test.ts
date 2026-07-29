// Tests for the pi.invokeTool self-patcher (src/patcher.ts).
//
// Runs against a throwaway fake-pi root copied from the pristine local
// node_modules pi dist — NEVER touches the real global install. The seam is
// applyInvokeToolPatch({ root, backupBase }).
//
// The strongest assertion here is byte-for-byte equality between a patched temp
// copy and the real globally-patched pi (when that install is present): it
// proves the patcher reproduces the hand-applied patch exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
	applyInvokeToolPatch,
	decidePatchAction,
	patchStatus,
	restorePatch,
	listSites,
	findPiRoot,
} from "../src/patcher.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
// Pristine (unpatched) pi dist shipped as a dev dependency.
const PRISTINE_DIST = path.join(
	REPO,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
);
// Candidate globally-patched installs, used only for the optional byte-match.
const GLOBAL_DIST_CANDIDATES = [
	path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist"),
	path.join("/usr/local/lib/node_modules", "@earendil-works", "pi-coding-agent", "dist"),
];

const TARGET_FILES = [
	"core/agent-session.js",
	"core/extensions/runner.js",
	"core/extensions/loader.js",
	"core/extensions/types.d.ts",
];

const PI_VERSION = "0.82.1";

/** Build a throwaway fake pi root from the pristine local dist. */
function makeFakeRoot(): { root: string; backupBase: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-test-"));
	const backupBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-bak-"));
	fs.mkdirSync(path.join(root, "dist", "core", "extensions"), { recursive: true });
	for (const rel of TARGET_FILES) {
		fs.copyFileSync(path.join(PRISTINE_DIST, rel), path.join(root, "dist", rel));
	}
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: PI_VERSION }),
	);
	return { root, backupBase };
}

/** First global candidate whose files actually carry the sentinels (i.e. really
 *  patched), or null. Used only for the optional byte-match assertion. */
function patchedGlobalDist(): string | null {
	for (const cand of GLOBAL_DIST_CANDIDATES) {
		try {
			const probe = fs.readFileSync(path.join(cand, "core/agent-session.js"), "utf8");
			if (probe.includes("async invokeTool(name, args = {}, options = {})")) return cand;
		} catch {
			/* not present on this machine */
		}
	}
	return null;
}

function countOccurrences(haystack: string, needle: string): number {
	let n = 0;
	let i = 0;
	for (;;) {
		i = haystack.indexOf(needle, i);
		if (i === -1) break;
		n++;
		i += needle.length;
	}
	return n;
}

test("apply: patches all sites, reports changed files, no errors", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		const before = patchStatus({ root, backupBase });
		assert.equal(before.present, false, "pristine root should report not-present");

		const res = applyInvokeToolPatch({ root, backupBase });

		assert.equal(res.patched, true);
		assert.equal(res.alreadyPresent, false);
		assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
		assert.equal(res.root, root);
		assert.equal(res.version, PI_VERSION);
		assert.equal(res.changedFiles.length, 4);
		assert.deepEqual([...res.changedFiles].sort(), [...TARGET_FILES].sort());

		// Every sentinel present, exactly once (no double-insertion).
		for (const site of listSites()) {
			const txt = fs.readFileSync(path.join(root, "dist", site.file), "utf8");
			assert.ok(txt.includes(site.sentinel), `missing sentinel in ${site.file}`);
			assert.equal(countOccurrences(txt, site.sentinel), 1, `sentinel duplicated in ${site.file}`);
		}
		assert.equal(patchStatus({ root, backupBase }).present, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("apply is idempotent: second run is a no-op", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		applyInvokeToolPatch({ root, backupBase });
		const again = applyInvokeToolPatch({ root, backupBase });
		assert.equal(again.patched, false);
		assert.equal(again.alreadyPresent, true);
		assert.equal(again.changedFiles.length, 0);
		// Still exactly one of each sentinel.
		for (const site of listSites()) {
			const txt = fs.readFileSync(path.join(root, "dist", site.file), "utf8");
			assert.equal(countOccurrences(txt, site.sentinel), 1, `sentinel duplicated after re-apply in ${site.file}`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("patched output is byte-identical to the real hand-patched global pi", () => {
	const g = patchedGlobalDist();
	if (!g) {
		console.warn("skipping byte-match: no patched global pi install found on this machine");
		return;
	}
	const { root, backupBase } = makeFakeRoot();
	try {
		applyInvokeToolPatch({ root, backupBase });
		for (const rel of TARGET_FILES) {
			const got: string = fs.readFileSync(path.join(root, "dist", rel), "utf8");
			const want: string = fs.readFileSync(path.join(g, rel), "utf8");
			assert.equal(got, want, `patched ${rel} differs from the hand-patched global install`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("anchor missing (version drift) aborts with no files written", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		// Wreck the site-1 anchor in agent-session.js but leave the file otherwise
		// recognizable (rename the method so the anchor string is gone).
		const f = path.join(root, "dist", "core/agent-session.js");
		let txt = fs.readFileSync(f, "utf8");
		txt = txt.replace("getToolDefinition(name)", "getToolDefinitionRenamed(name)");
		fs.writeFileSync(f, txt);

		const res = applyInvokeToolPatch({ root, backupBase });
		assert.equal(res.patched, false);
		assert.equal(res.present, false);
		assert.ok(res.errors.length > 0);
		assert.match(res.errors[0], /anchor not found/i);

		// No sentinel should have landed anywhere (zero writes happened).
		for (const site of listSites()) {
			const after = fs.readFileSync(path.join(root, "dist", site.file), "utf8");
			assert.ok(!after.includes(site.sentinel), `site ${site.file} was written despite abort`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("restore round-trips files back to pristine", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		const pristine = new Map<string, string>();
		for (const rel of TARGET_FILES) {
			pristine.set(rel, fs.readFileSync(path.join(root, "dist", rel), "utf8"));
		}

		applyInvokeToolPatch({ root, backupBase });
		const r = restorePatch({ root, backupBase });
		assert.equal(r.ok, true, r.reason ?? "restore failed");
		assert.equal(r.restoredFiles.length, 4);

		for (const rel of TARGET_FILES) {
			const after = fs.readFileSync(path.join(root, "dist", rel), "utf8");
			assert.equal(after, pristine.get(rel), `${rel} not restored to pristine`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("restore refuses a version mismatch (no silent downgrade)", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		applyInvokeToolPatch({ root, backupBase });
		// Simulate a pi upgrade: bump the installed version after the backup.
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.0" }),
		);
		const r = restorePatch({ root, backupBase });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /refusing restore/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("restore with no backup reports failure (no silent success)", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		const r = restorePatch({ root, backupBase });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /no backup found/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("backup dir is pid-namespaced (no same-ms collision)", () => {
	const { root, backupBase } = makeFakeRoot();
	try {
		const res = applyInvokeToolPatch({ root, backupBase });
		assert.ok(res.backupDir);
		assert.ok(
			path.basename(res.backupDir).endsWith(`-${process.pid}`),
			"backup dir not pid-namespaced",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("backup captures the validated original, not the patched disk state", () => {
	// Guards the TOCTOU fixed by backing up in-memory `original` (not a re-read):
	// the backed-up bytes must equal pristine even though the on-disk file is
	// patched by the time phase-2 completes.
	const { root, backupBase } = makeFakeRoot();
	try {
		const pristineAgent = fs.readFileSync(
			path.join(root, "dist", "core/agent-session.js"),
			"utf8",
		);
		const res = applyInvokeToolPatch({ root, backupBase });
		assert.equal(res.patched, true);
		assert.ok(res.backupDir);
		const backed = fs.readFileSync(
			path.join(res.backupDir!, "core/agent-session.js"),
			"utf8",
		);
		assert.equal(backed, pristineAgent, "backup captured patched bytes instead of pristine");
		const onDisk = fs.readFileSync(path.join(root, "dist", "core/agent-session.js"), "utf8");
		assert.notEqual(onDisk, pristineAgent, "on-disk file was not actually patched");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(backupBase, { recursive: true, force: true });
	}
});

test("findPiRoot resolves and verifies the real running pi (sanity)", () => {
	const root = findPiRoot();
	// In CI without pi this may be null; only assert when present.
	if (!root) {
		console.warn("skipping findPiRoot: no verified pi install on PATH");
		return;
	}
	assert.equal(root.version, PI_VERSION);
	assert.ok(fs.existsSync(path.join(root.root, "dist", "core", "agent-session.js")));
});

// --- decidePatchAction: the consent-gate decision matrix -------------------

test("decidePatchAction: live patch always proceeds", () => {
	assert.equal(decidePatchAction(true, false, false, false).kind, "proceed");
	assert.equal(decidePatchAction(true, true, true, true).kind, "proceed");
});

test("decidePatchAction: on disk but not live -> notify-restart", () => {
	assert.equal(decidePatchAction(false, true, false, false).kind, "notify-restart");
	// Even if previously declined: a present-on-disk patch just needs a restart.
	assert.equal(decidePatchAction(false, true, true, true).kind, "notify-restart");
});

test("decidePatchAction: missing + previously declined -> silent (no nag)", () => {
	assert.equal(decidePatchAction(false, false, true, true).kind, "silent");
	assert.equal(decidePatchAction(false, false, true, false).kind, "silent");
});

test("decidePatchAction: missing + not declined + has UI -> ask", () => {
	assert.equal(decidePatchAction(false, false, false, true).kind, "ask");
});

test("decidePatchAction: missing + not declined + no UI -> headless-skip", () => {
	assert.equal(decidePatchAction(false, false, false, false).kind, "headless-skip");
});
