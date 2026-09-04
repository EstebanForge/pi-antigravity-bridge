// BROWSER-capture tests (OAuth login URL surfacing). Fully offline: the
// record file and the wrapper script live in a temp data dir, and PATH/env
// come from injected values.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { findOnPath, parseAuthPort, readLastUrl, setupAuthUrlCapture } from "../src/acp/browser-capture.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-capture-"));
}

// URL anatomy from a captured login (docs/ACP-PROTOCOL-REFERENCE.md).
const CAPTURED = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35293%2F&state=xyz&prompt=consent";

describe("acp/browser-capture parseAuthPort", () => {
	test("extracts the loopback redirect port", () => {
		assert.equal(parseAuthPort(CAPTURED), 35293);
	});

	test("no redirect_uri, no port, or garbage all give null", () => {
		assert.equal(parseAuthPort("https://accounts.google.com/o/oauth2/v2/auth?x=1"), null);
		assert.equal(parseAuthPort("https://example.com/redirect?redirect_uri=http%3A%2F%2F127.0.0.1%2Fpath"), null);
		assert.equal(parseAuthPort("not a url"), null);
	});
});

describe("acp/browser-capture readLastUrl", () => {
	test("returns the last http(s) line, skipping noise", () => {
		const file = path.join(tmpDir(), "urls.log");
		fs.writeFileSync(file, `noise before\n${CAPTURED}\nmore noise\nhttps://example.com/after\n`);
		assert.equal(readLastUrl(file), "https://example.com/after");
	});

	test("empty or missing file gives null", () => {
		assert.equal(readLastUrl(path.join(tmpDir(), "empty.log")), null);
		fs.writeFileSync(path.join(tmpDir(), "noise.log"), "no urls here\n");
		assert.equal(readLastUrl(path.join(tmpDir(), "noise.log")), null);
	});
});

describe("acp/browser-capture findOnPath", () => {
	test("finds executables on the injected PATH only", () => {
		const dir = tmpDir();
		const fake = path.join(dir, "xdg-open");
		fs.writeFileSync(fake, "#!/bin/sh\n");
		fs.chmodSync(fake, 0o755);
		assert.equal(findOnPath("xdg-open", { PATH: dir }), fake);
		assert.equal(findOnPath("xdg-open", { PATH: "/nonexistent-dir" }), null);
	});

	test("a non-executable file is not a hit", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "xdg-open"), "data");
		assert.equal(findOnPath("xdg-open", { PATH: dir }), null);
	});
});

describe("acp/browser-capture setupAuthUrlCapture", () => {
	test("writes an executable wrapper that records and forwards", () => {
		const cap = setupAuthUrlCapture(tmpDir(), { PATH: "/nonexistent-dir" });
		assert.ok(cap);
		const wrapper = cap.browserEnv.BROWSER;
		assert.equal(path.basename(wrapper), "acp-browser-wrapper.sh");
		assert.ok((fs.statSync(wrapper).mode & 0o111) !== 0, "wrapper must be executable");
		const body = fs.readFileSync(wrapper, "utf8");
		assert.match(body, /^#!\/usr\/bin\/env sh$/m);
		// Appends every argument (the URL) to the record file...
		assert.ok(body.includes(`>> '${cap.file}'`), "must append to the record file");
		// ...and with no opener found, exits without one (headless no-op).
		assert.ok(body.includes('if [ -n "$REAL" ]'), "must branch on the opener");
		// The record file starts empty (mirrors the current login attempt).
		assert.equal(fs.readFileSync(cap.file, "utf8"), "");
		assert.equal(cap.lastUrl(), null);
	});

	test("chains an existing BROWSER opener into the wrapper", () => {
		const dir = tmpDir();
		const mine = path.join(dir, "my-browser");
		fs.writeFileSync(mine, "#!/bin/sh\n");
		fs.chmodSync(mine, 0o755);
		const cap = setupAuthUrlCapture(dir, { BROWSER: mine });
		assert.ok(cap);
		const body = fs.readFileSync(cap.browserEnv.BROWSER, "utf8");
		assert.ok(body.includes(`REAL='${mine}'`));
		// Flag forms of BROWSER forward with word splitting (set -f: no globs).
		assert.ok(body.includes("set -f; exec $REAL \"$@\""));
	});

	test("lastUrl sees URLs appended after setup", () => {
		const cap = setupAuthUrlCapture(tmpDir(), { PATH: "/nonexistent-dir" });
		assert.ok(cap);
		assert.equal(cap.lastUrl(), null);
		fs.appendFileSync(cap.file, CAPTURED + "\n");
		assert.equal(cap.lastUrl(), CAPTURED);
		assert.equal(parseAuthPort(cap.lastUrl()!), 35293);
	});

	test("rewriting with unchanged inputs keeps the wrapper stable", () => {
		const dir = tmpDir();
		const first = setupAuthUrlCapture(dir, { PATH: "/nonexistent-dir" });
		const before = fs.readFileSync(first!.browserEnv.BROWSER, "utf8");
		const second = setupAuthUrlCapture(dir, { PATH: "/nonexistent-dir" });
		assert.equal(second!.browserEnv.BROWSER, first!.browserEnv.BROWSER);
		assert.equal(fs.readFileSync(second!.browserEnv.BROWSER, "utf8"), before);
	});
});
