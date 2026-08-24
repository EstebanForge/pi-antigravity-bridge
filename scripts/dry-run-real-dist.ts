// End-to-end dry run against a COPY of a real installed pi dist.
// Usage: npx tsx scripts/dry-run-real-dist.ts [pi-package-root]
// (no arg = the local devDependency install). Read-only wrt the source root:
// proves sites + entry redirect apply cleanly to the exact files pi runs.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { applyInvokeToolPatch, patchStatus, restorePatch } from "../src/patcher.js";

const require = createRequire(import.meta.url);
const SRC = process.argv[2] ?? path.join(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")), "..");
const SRC_VERSION = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version;
const FILES = [
	"core/agent-session.js",
	"core/extensions/runner.js",
	"core/extensions/loader.js",
	"core/extensions/types.d.ts",
	"bundle/cli.js",
	"cli.js",
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-real-dist-"));
const backupBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-real-bak-"));
fs.mkdirSync(path.join(root, "dist/core/extensions"), { recursive: true });
fs.mkdirSync(path.join(root, "dist/bundle"), { recursive: true });
for (const rel of FILES) fs.copyFileSync(path.join(SRC, "dist", rel), path.join(root, "dist", rel));
fs.writeFileSync(
	path.join(root, "package.json"),
	JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: SRC_VERSION }),
);

const res = applyInvokeToolPatch({ root, backupBase });
console.log("src:", SRC);
console.log("apply:", JSON.stringify({ patched: res.patched, errors: res.errors, changedFiles: res.changedFiles }));
console.log("status present:", patchStatus({ root, backupBase }).present);
console.log("shim head:", JSON.stringify(fs.readFileSync(path.join(root, "dist/bundle/cli.js"), "utf8").split("\n").slice(0, 5)));
const r = restorePatch({ root, backupBase });
console.log("restore:", JSON.stringify({ ok: r.ok, restoredFiles: r.restoredFiles }));
console.log("entry restored to original:", fs.readFileSync(path.join(root, "dist/bundle/cli.js"), "utf8").includes("chunks/"));
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(backupBase, { recursive: true, force: true });
