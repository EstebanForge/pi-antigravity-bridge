// Self-applier for the pi.invokeTool local patch (docs/PI-INVOKETOOL-PATCH.md).
//
// Adds pi.invokeTool() at 6 sites in 4 compiled files under pi's dist/. pi ships
// compiled (no src/); these are plain, sentinel-detectable text insertions, so a
// runtime patcher can apply them durably and idempotently. This lets the bridge
// self-heal after a pi reinstall/update without manual re-patching.
//
// Activation: pi's core is native ESM, cached per process; /reload does NOT pick
// up these edits. A patched dist only takes effect on a FULL pi restart. The
// extension notifies the user accordingly (see extensions/index.ts).
//
// Hardening (peer-reviewed):
//   - Two-phase apply: validate every anchor/sentinel BEFORE writing anything,
//     so a missing anchor (version drift) aborts with zero files touched.
//   - Facade (loader.js) is written LAST: a crashed/partial patch leaves
//     hasInvokeTool() === false (safe degraded), never a half-wired chain.
//   - Per-pid temp file + rename (atomic per file): no torn writes, no
//     concurrent-launch race (mirrors mcp-server.ts writeBridgeMcpConfig).
//   - Backups carry a VERSION stamp; restore refuses a version mismatch so it
//     can never silently downgrade a newer pi's shipped core.
//   - Actionable EACCES message for sudo-installed pi.
//   - No jiti cache clear: pi 0.82.1 sets moduleCache:false (loader.js), so jiti
//     never fs-caches; rm -rf /tmp/jiti is a no-op here.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const BRIDGE_BASE = path.join(os.homedir(), ".pi", "agent", "antigravity-bridge");
export const PATCH_BACKUP_DIR = path.join(BRIDGE_BASE, "pi-patch-backup");

/** One insertion site in one compiled file. */
interface PatchSite {
	/** Path relative to pi's dist/. */
	file: string;
	/** Unique existing text; insertion is placed immediately after it. */
	anchor: string;
	/** Text appended after the anchor (no leading newline; one is added). */
	insertion: string;
	/** Substring proving this site is already patched (idempotency guard). */
	sentinel: string;
}

// Write order is significant: facade (loader.js) MUST be last so a partial
// patch fails closed (hasInvokeTool reads the facade). Sites within a file are
// applied together in one atomic write.
const PATCH_FILES: Array<{ file: string; sites: PatchSite[] }> = [
	{
		file: "core/agent-session.js",
		sites: [
			{
				file: "core/agent-session.js",
				anchor:
					"    getToolDefinition(name) {\n        return this._toolDefinitions.get(name)?.definition;\n    }\n",
				insertion: `    /**
     * LOCAL PATCH (pi-antigravity-bridge): invoke a registered tool by name
     * out-of-band and return its result. The tool wrapper synthesizes ctx via
     * its ctxFactory when none is passed. Not upstream pi (yet).
     */
    async invokeTool(name, args = {}, options = {}) {
        const tool = this._toolRegistry.get(name);
        if (!tool) {
            throw new Error(\`invokeTool: tool "\${name}" not found in registry\`);
        }
        const toolCallId = options.toolCallId ?? \`invokeTool:\${name}:\${Date.now()}\`;
        return tool.execute(toolCallId, args, options.signal ?? undefined, options.onUpdate);
    }
`,
				sentinel: "async invokeTool(name, args = {}, options = {}) {",
			},
			{
				file: "core/agent-session.js",
				anchor: "            refreshTools: () => this._refreshToolRegistry(),\n",
				insertion:
					"            invokeTool: (name, args, options) => this.invokeTool(name, args, options),\n",
				sentinel:
					"invokeTool: (name, args, options) => this.invokeTool(name, args, options),",
			},
		],
	},
	{
		file: "core/extensions/runner.js",
		sites: [
			{
				file: "core/extensions/runner.js",
				anchor: "        this.runtime.refreshTools = actions.refreshTools;\n",
				insertion: "        this.runtime.invokeTool = actions.invokeTool;\n",
				sentinel: "this.runtime.invokeTool = actions.invokeTool;",
			},
			{
				file: "core/extensions/runner.js",
				anchor:
					"    getActiveTools() {\n        this.assertActive();\n        return this.runtime.getActiveTools();\n    }\n",
				insertion: `    invokeTool(name, args, options) {
        this.assertActive();
        return this.runtime.invokeTool(name, args, options);
    }
`,
				sentinel: "return this.runtime.invokeTool(name, args, options);",
			},
		],
	},
	{
		file: "core/extensions/types.d.ts",
		sites: [
			{
				file: "core/extensions/types.d.ts",
				anchor: "    getAllTools(): ToolInfo[];\n",
				insertion: `    /**
     * LOCAL PATCH (pi-antigravity-bridge): invoke a registered tool by name
     * out-of-band and return { content, details, isError? }. ctx is synthesized.
     */
    invokeTool(name: string, args?: Record<string, unknown>, options?: { toolCallId?: string; signal?: AbortSignal; onUpdate?: (update: unknown) => void }): Promise<{ content: unknown[]; details: unknown; isError?: boolean }>;
`,
				sentinel: "invokeTool(name: string, args?: Record<string, unknown>",
			},
		],
	},
	{
		// Facade. Written LAST on purpose (see file header).
		file: "core/extensions/loader.js",
		sites: [
			{
				file: "core/extensions/loader.js",
				anchor:
					"        getAllTools() {\n            runtime.assertActive();\n            return runtime.getAllTools();\n        },\n",
				insertion: `        invokeTool(name, args, options) {
            runtime.assertActive();
            return runtime.invokeTool(name, args, options);
        },
`,
				sentinel: "return runtime.invokeTool(name, args, options);",
			},
		],
	},
];

const ALL_SITES: PatchSite[] = PATCH_FILES.flatMap((f) => f.sites);

export interface PatchResult {
	/** True when every required site is present (after this run). */
	present: boolean;
	/** True when >=1 file was actually written this run. */
	patched: boolean;
	/** True when all sites were already present and nothing was written. */
	alreadyPresent: boolean;
	root?: string;
	version?: string;
	changedFiles: string[];
	backupDir?: string;
	errors: string[];
}

export interface PatchStatus {
	/** True when every sentinel is present across all files. */
	present: boolean;
	root?: string;
	version?: string;
	/** Site labels missing (by file). */
	missing: string[];
	/** Newest backup dir found, if any. */
	backupDir?: string;
	backupVersion?: string;
}

export interface RestoreResult {
	ok: boolean;
	restoredFiles: string[];
	backupDir?: string;
	reason?: string;
}

type Logger = (s: string, d?: unknown) => void;

/** Read the installed pi version from a package root's package.json. */
function readVersion(root: string): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		if (pkg?.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
	} catch {
		/* not a pi root */
	}
	return undefined;
}

/** Verify a candidate is a real pi package root whose dist holds the target
 *  files. This is the safety net that makes multi-strategy root-finding safe:
 *  a wrong candidate (a sibling extension's decoy node_modules copy) fails here. */
function verifyRoot(root: string): { root: string; version: string } | null {
	if (!root) return null;
	const version = readVersion(root);
	if (!version) return null;
	// The anchor of site 1 is the most specific fingerprint of a real, unedited
	// pi agent-session.js. Require its file to exist and contain it.
	const probe = path.join(root, "dist", "core", "agent-session.js");
	try {
		const txt = fs.readFileSync(probe, "utf8");
		// Accept either patched or unpatched: the getToolDefinition body is stable.
		if (!txt.includes("getToolDefinition(name)")) return null;
	} catch {
		return null;
	}
	// All target files must exist.
	for (const f of PATCH_FILES) {
		if (!fs.existsSync(path.join(root, "dist", f.file))) return null;
	}
	return { root, version };
}

/** Candidate from realpath(process.argv[1]) — the pi cli entry the OS launched.
 *  Most reliable signal for the RUNNING pi regardless of node_modules layout. */
function candidateFromArgv(): string | null {
	try {
		const launched = process.argv[1];
		if (!launched) return null;
		const real = fs.realpathSync(launched);
		const dir = path.dirname(real);
		if (path.basename(dir) === "dist") return path.dirname(dir);
		// Some launchers place the entry directly under <root>/dist; if not, bail.
		return null;
	} catch {
		return null;
	}
}

/** Candidate from import.meta.resolve — works in single-install (normal npm -g)
 *  layouts. NOTE: in a dev dual-install this resolves the LOCAL node_modules copy,
 *  not the running global pi; verifyRoot + the argv strategy keep it safe. */
function candidateFromResolve(): string | null {
	try {
		const url = import.meta.resolve(PACKAGE_NAME);
		const mainFile = fileURLToPath(url); // .../dist/index.js
		const dist = path.dirname(mainFile);
		if (path.basename(dist) === "dist") return path.dirname(dist);
		return null;
	} catch {
		return null;
	}
}

/** Candidate from `npm root -g`. */
function candidateFromNpmGlobal(): string | null {
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return path.join(root, PACKAGE_NAME);
	} catch {
		return null;
	}
}

/** Candidates from well-known global install locations + env overrides. */
function candidateFromKnownPaths(): string[] {
	const out: string[] = [];
	if (process.env.PI_PACKAGE_ROOT) out.push(process.env.PI_PACKAGE_ROOT);
	const home = os.homedir();
	out.push(path.join(home, ".npm-global", "lib", "node_modules", PACKAGE_NAME));
	out.push(path.join("/usr/local/lib/node_modules", PACKAGE_NAME));
	out.push(path.join("/usr/lib/node_modules", PACKAGE_NAME));
	if (process.env.NVM_DIR) {
		out.push(path.join(process.env.NVM_DIR, "lib", "node_modules", PACKAGE_NAME));
	}
	return out;
}

/** Locate the running pi's package root. Verify-as-you-go and short-circuit on
 *  the first verified candidate, so the common case (argv already resolves)
 *  never spawns `npm root -g`. */
export function findPiRoot(): { root: string; version: string } | null {
	const tried = new Set<string>();
	const attempt = (cand: string | null): { root: string; version: string } | null => {
		if (!cand || tried.has(cand)) return null;
		tried.add(cand);
		return verifyRoot(cand);
	};
	// Cheapest + most reliable first: the OS-launched pi entry.
	let v = attempt(candidateFromArgv());
	if (v) return v;
	// ESM resolution (single-install layouts).
	v = attempt(candidateFromResolve());
	if (v) return v;
	// Only now (argv + resolve both missed) pay for spawning npm.
	v = attempt(candidateFromNpmGlobal());
	if (v) return v;
	// Known global locations + PI_PACKAGE_ROOT env override.
	for (const k of candidateFromKnownPaths()) {
		v = attempt(k);
		if (v) return v;
	}
	return null;
}

/** Whether every site's sentinel is already present. */
function siteMissing(content: string, site: PatchSite): boolean {
	return !content.includes(site.sentinel);
}

/** Atomic write: per-pid tmp in the SAME dir (same filesystem) + rename. */
function atomicWrite(filePath: string, content: string): void {
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filePath);
}

/** Persist the validated pre-write content into the backup dir, mirroring path.
 *  Backs up the in-memory `original` (NOT a fresh disk read) so a concurrent
 *  apply between phase-1 and phase-2 can never capture already-patched bytes. */
function backupOriginal(file: string, content: string, backupDir: string): void {
	const dst = path.join(backupDir, file);
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.writeFileSync(dst, content);
}

/** Human-readable, actionable message for a write failure (sudo-global pi). */
function describeWriteError(err: unknown, root: string): string {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === "EACCES" || code === "EPERM") {
		return (
			`permission denied writing under ${root}. pi was likely installed with sudo. ` +
			`Fix: 'sudo chown -R "$(id -un)" "${root}"', or reinstall pi under a user-writable prefix ` +
			`('npm config set prefix "${path.join(os.homedir(), ".npm-global")}"' then 'npm i -g ${PACKAGE_NAME}').`
		);
	}
	return err instanceof Error ? err.message : String(err);
}

/** Find the newest backup dir (by VERSION file mtime), if any. */
function findNewestBackup(base: string): { dir: string; version: string } | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(base);
	} catch {
		return null;
	}
	let best: { dir: string; version: string; mtime: number } | null = null;
	for (const name of entries) {
		const dir = path.join(base, name);
		const verFile = path.join(dir, "VERSION");
		try {
			const stat = fs.statSync(verFile);
			const manifest = JSON.parse(fs.readFileSync(verFile, "utf8"));
			if (typeof manifest.version !== "string") continue;
			if (!best || stat.mtimeMs > best.mtime) {
				best = { dir, version: manifest.version, mtime: stat.mtimeMs };
			}
		} catch {
			/* incomplete backup entry */
		}
	}
	return best ? { dir: best.dir, version: best.version } : null;
}

/** Shared options. root/backupBase are test seams (and let /agy patch target a
 *  specific install); production calls omit them and use auto-discovery. */
export interface PatchOpts {
	root?: string;
	backupBase?: string;
	log?: Logger;
}

function resolveRoot(opts: { root?: string }): { root: string; version: string } | null {
	return opts.root ? verifyRoot(opts.root) : findPiRoot();
}

function backupBaseOf(opts: { backupBase?: string }): string {
	return opts.backupBase ?? PATCH_BACKUP_DIR;
}

/** Report the current patch state without changing anything. */
export function patchStatus(opts: { root?: string; backupBase?: string } = {}): PatchStatus {
	const root = resolveRoot(opts);
	if (!root) {
		return { present: false, missing: ["pi-root-not-found"] };
	}
	const missing: string[] = [];
	for (const f of PATCH_FILES) {
		let txt = "";
		try {
			txt = fs.readFileSync(path.join(root.root, "dist", f.file), "utf8");
		} catch {
			missing.push(f.file);
			continue;
		}
		for (const site of f.sites) {
			if (siteMissing(txt, site)) missing.push(`${f.file}:${site.sentinel.slice(0, 40)}`);
		}
	}
	const backup = findNewestBackup(backupBaseOf(opts));
	return {
		present: missing.length === 0,
		root: root.root,
		version: root.version,
		missing,
		backupDir: backup?.dir,
		backupVersion: backup?.version,
	};
}

/** What session_start should do about the patch + MCP bridge, given the four
 *  observable signals. Pure so the matrix is unit-testable without a pi harness. */
export type PatchAction =
	| { kind: "proceed" }       // patch is live: start the MCP bridge
	| { kind: "notify-restart" } // on disk but not live this process: tell user to restart
	| { kind: "silent" }        // user declined: do nothing, stay quiet
	| { kind: "ask" }           // missing + has UI: show the consent gate
	| { kind: "headless-skip" }; // missing + no UI: log and skip (can't ask)

/** Decide the session_start patch action. Precedence:
 *  live > on-disk-needs-restart > declined > interactive-ask > headless-skip. */
export function decidePatchAction(
	live: boolean,
	diskPresent: boolean,
	declined: boolean,
	hasUI: boolean,
): PatchAction {
	if (live) return { kind: "proceed" };
	if (diskPresent) return { kind: "notify-restart" };
	if (declined) return { kind: "silent" };
	return hasUI ? { kind: "ask" } : { kind: "headless-skip" };
}

/** Apply the patch idempotently. Two-phase: validate all anchors first, write
 *  only if something is missing. Facade file is written last. */
export function applyInvokeToolPatch(opts: PatchOpts = {}): PatchResult {
	const log = opts.log ?? (() => {});
	const errors: string[] = [];
	const changedFiles: string[] = [];

	const found = resolveRoot(opts);
	if (!found) {
		const msg =
			"could not locate the running pi package root (tried argv, import.meta.resolve, npm root -g, and known paths, none verified). Is pi installed? For a bundled-binary pi there are no JS files to patch.";
		log("root-not-found", msg);
		return { present: false, patched: false, alreadyPresent: false, changedFiles, errors: [msg] };
	}
	const { root, version } = found;
	log("root", { root, version });

	// Phase 1: read every file, validate anchors/sentinels, build the change plan.
	type Plan = { file: string; original: string; next: string; changed: boolean };
	const plan: Plan[] = [];
	for (const f of PATCH_FILES) {
		const filePath = path.join(root, "dist", f.file);
		let original: string;
		try {
			original = fs.readFileSync(filePath, "utf8");
		} catch (e) {
			errors.push(`cannot read ${f.file}: ${e instanceof Error ? e.message : String(e)}`);
			return { present: false, patched: false, alreadyPresent: false, changedFiles, errors, root, version };
		}
		let next = original;
		let changed = false;
		for (const site of f.sites) {
			if (!siteMissing(original, site)) continue; // already patched at this site
			if (!original.includes(site.anchor)) {
				// Version drift: the code pi ships moved/renamed. Abort cleanly.
				const msg =
					`anchor not found in ${f.file} (pi ${version}). pi's structure changed; ` +
					`the patch needs updating for this version. No files were written. ` +
					`See docs/PI-INVOKETOOL-PATCH.md.`;
				errors.push(msg);
				log("anchor-missing", { file: f.file, version });
				return { present: false, patched: false, alreadyPresent: false, changedFiles, errors, root, version };
			}
			next = next.replace(site.anchor, site.anchor + site.insertion);
			changed = true;
		}
		plan.push({ file: f.file, original, next, changed });
	}

	const anyChange = plan.some((p) => p.changed);
	if (!anyChange) {
		log("already-present", { root, version });
		return { present: true, patched: false, alreadyPresent: true, changedFiles, errors, root, version };
	}

	// Phase 2: back up originals (one VERSION-stamped dir), then write facade-last.
	const stamp = `${version}-${Date.now()}-${process.pid}`;
	const backupDir = path.join(backupBaseOf(opts), stamp);
	try {
		fs.mkdirSync(backupDir, { recursive: true });
		fs.writeFileSync(
			path.join(backupDir, "VERSION"),
			`${JSON.stringify({ version, root, createdAt: new Date().toISOString() }, null, 2)}\n`,
		);
		// Back up the validated originals (in memory) for restore.
		for (const p of plan) backupOriginal(p.file, p.original, backupDir);
		log("backup-written", { backupDir });
	} catch (e) {
		const msg = `backup failed (${e instanceof Error ? e.message : String(e)}); aborting before any write.`;
		errors.push(msg);
		return { present: false, patched: false, alreadyPresent: false, changedFiles, errors, root, version };
	}

	// Write in declared order (facade/loader.js is last in PATCH_FILES).
	for (const p of plan) {
		if (!p.changed) continue;
		const filePath = path.join(root, "dist", p.file);
		try {
			atomicWrite(filePath, p.next);
			changedFiles.push(p.file);
			log("file-patched", { file: p.file });
		} catch (e) {
			const msg = describeWriteError(e, root);
			errors.push(`failed writing ${p.file}: ${msg}`);
			log("write-failed", { file: p.file, code: (e as NodeJS.ErrnoException)?.code });
			// Stop here; earlier files in this run are already patched and backed
			// up, so a retry (or restore) recovers cleanly. hasInvokeTool() stays
			// false unless the facade (last file) already succeeded.
			break;
		}
	}

	const status = patchStatus({ root, backupBase: opts.backupBase });
	return {
		present: status.present,
		patched: changedFiles.length > 0,
		alreadyPresent: false,
		changedFiles,
		backupDir,
		errors,
		root,
		version,
	};
}

/** Restore the most recent backup. Refuses if the installed pi version differs
 *  from the backup's version (prevents silently downgrading shipped core). */
export function restorePatch(opts: PatchOpts = {}): RestoreResult {
	const log = opts.log ?? (() => {});
	const found = resolveRoot(opts);
	if (!found) {
		return { ok: false, restoredFiles: [], reason: "could not locate the running pi package root to restore into." };
	}
	const { root, version } = found;
	const backup = findNewestBackup(backupBaseOf(opts));
	if (!backup) {
		return { ok: false, restoredFiles: [], reason: "no backup found; nothing to restore." };
	}
	if (backup.version !== version) {
		const msg =
			`refusing restore: backup is from pi ${backup.version} but installed pi is ${version}. ` +
			`Restoring across versions would downgrade pi's shipped core files. Delete the backup manually if intended.`;
		log("restore-version-mismatch", { backup: backup.version, installed: version });
		return { ok: false, restoredFiles: [], backupDir: backup.dir, reason: msg };
	}

	const restoredFiles: string[] = [];
	for (const f of PATCH_FILES) {
		const src = path.join(backup.dir, f.file);
		const dst = path.join(root, "dist", f.file);
		if (!fs.existsSync(src)) continue;
		try {
			const content = fs.readFileSync(src, "utf8");
			atomicWrite(dst, content);
			restoredFiles.push(f.file);
		} catch (e) {
			const msg = describeWriteError(e, root);
			return { ok: false, restoredFiles, backupDir: backup.dir, reason: `failed restoring ${f.file}: ${msg}` };
		}
	}
	log("restore-done", { backupDir: backup.dir, count: restoredFiles.length });
	return { ok: true, restoredFiles, backupDir: backup.dir };
}

/** Exposed for tests: the full site list (read-only view). */
export function listSites(): ReadonlyArray<Readonly<PatchSite>> {
	return ALL_SITES;
}
