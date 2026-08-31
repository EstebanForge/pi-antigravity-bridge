// Tests for the legacy-patch cleanup module. Every test names the break it
// catches; expectations are hand-derived literals, never computed by the
// module under test. Real fs via tmpdirs: the module's own test seams
// (PatchOpts.root / backupBase) keep everything real, no mocks.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSites, patchStatus, restorePatch } from "../src/patch-cleanup.js";

const SITES = listSites();
const FILES = [...new Set(SITES.map((s) => s.file))].concat(["bundle/cli.js"]);
const VERSION = "0.84.3";
const SITE_1_ANCHOR =
	"    getToolDefinition(name) {\n        return this._toolDefinitions.get(name)?.definition;\n    }\n";

/** A stand-in installed pi: package.json + the four target files. When
 *  `patched` is false the files hold only their real anchors (clean dist). */
function makePiRoot(base: string, version: string, patched: boolean): string {
	const root = path.join(base, `pi-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(path.join(root, "dist", "bundle"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
	);
	const content = new Map<string, string>();
	for (const site of SITES) {
		const prev = content.get(site.file) ?? "";
		content.set(site.file, prev + SITE_1_ANCHOR + (patched ? site.insertion : ""));
	}
	for (const [rel, body] of content) {
		fs.mkdirSync(path.join(root, "dist", path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(root, "dist", rel), body);
	}
	fs.writeFileSync(
		path.join(root, "dist", "bundle", "cli.js"),
		patched ? 'import "../cli.js";' : 'import "./chunks/entry-abc.js";',
	);
	return root;
}

/** A backup dir exactly as the old patcher left it: VERSION manifest + clean
 *  copies of every target file, contents the restore assertions can name. */
function makeBackup(base: string, version: string): string {
	const dir = path.join(base, `pi-${version}-${Math.random().toString(36).slice(2, 6)}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "VERSION"), JSON.stringify({ version }));
	for (const rel of FILES) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), `RESTORED:${rel}`);
	}
	return dir;
}

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-cleanup-"));
}

test("cleanup: restore picks the backup matching the installed pi, not the newest one", () => {
	// The shipped bug: newest-by-mtime picked a 0.84.4 backup for a 0.84.3 pi
	// and refused, while a matching 0.84.3 backup sat next to it.
	const base = tmpdir();
	const root = makePiRoot(base, VERSION, true);
	makeBackup(base, "0.84.3");
	// Written last so it is newest by mtime.
	makeBackup(base, "0.84.4");
	const r = restorePatch({ root, backupBase: base });
	assert.equal(r.ok, true, r.reason);
	assert.ok(r.backupDir!.includes("0.84.3"));
	fs.rmSync(base, { recursive: true, force: true });
});

test("cleanup: restore refuses a cross-version restore that would downgrade pi", () => {
	const base = tmpdir();
	const root = makePiRoot(base, "0.84.9", true);
	makeBackup(base, VERSION);
	const r = restorePatch({ root, backupBase: base });
	assert.equal(r.ok, false);
	assert.match(r.reason!, /refusing restore/);
	fs.rmSync(base, { recursive: true, force: true });
});

test("cleanup: restore fails closed when no backup exists", () => {
	const base = tmpdir();
	const root = makePiRoot(base, VERSION, true);
	const r = restorePatch({ root, backupBase: base });
	assert.equal(r.ok, false);
	assert.match(r.reason!, /no backup found/);
	fs.rmSync(base, { recursive: true, force: true });
});

test("cleanup: restore copies backup bytes over every patched dist file", () => {
	// Break caught: restoring nothing, or restoring the wrong file's bytes.
	const base = tmpdir();
	const root = makePiRoot(base, VERSION, true);
	makeBackup(base, VERSION);
	const r = restorePatch({ root, backupBase: base });
	assert.equal(r.ok, true, r.reason);
	assert.ok(r.restoredFiles.includes("core/agent-session.js"));
	assert.ok(r.restoredFiles.includes("bundle/cli.js"));
	for (const rel of FILES) {
		assert.equal(
			fs.readFileSync(path.join(root, "dist", rel), "utf8"),
			`RESTORED:${rel}`,
			`wrong bytes restored into ${rel}`,
		);
	}
	fs.rmSync(base, { recursive: true, force: true });
});

test("cleanup: patchStatus separates a patched install from a clean one", () => {
	const base = tmpdir();
	const patched = patchStatus({ root: makePiRoot(base + "-p", VERSION, true), backupBase: base });
	assert.equal(patched.present, true);
	assert.deepEqual(patched.missing, []);
	const cleanBase = tmpdir();
	const clean = patchStatus({ root: makePiRoot(cleanBase, VERSION, false), backupBase: cleanBase });
	assert.equal(clean.present, false);
	assert.ok(clean.missing.length >= SITES.length);
	fs.rmSync(base, { recursive: true, force: true });
	fs.rmSync(cleanBase, { recursive: true, force: true });
});

test("cleanup: restore fails closed when the pi root is not a real install", () => {
	const base = tmpdir();
	const bogus = path.join(base, "not-pi");
	fs.mkdirSync(bogus);
	const r = restorePatch({ root: bogus, backupBase: base });
	assert.equal(r.ok, false);
	assert.match(r.reason!, /could not locate/);
	fs.rmSync(base, { recursive: true, force: true });
});
