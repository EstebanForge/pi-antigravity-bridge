// ACP engine self-service setup: binary install from the official registry
// and auth bootstrap. Everything is automatic when possible; the caller
// surfaces `manual` only when a step fails. Instructions-as-first-resort is
// gone: /agy engine acp and session_start self-heal silently when ready.
//
// Sources: docs/ACP-ADOPTION-PLAN.md §2.1 (registry entry), §12 (pinned
// install layout: ~/.local/opt/agy-acp/<build>/ + current symlink, zip
// sha256 recorded at install time), docs/ACP-PROTOCOL-REFERENCE.md
// (settings.json auth shapes; the server opens the oauth browser itself).
// Credential rule: this module never reads or writes credential VALUES —
// acp_token.json is only stat()ed, gemini-api-key is read by the server
// from the environment.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_URL =
	"https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

const INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface SetupOptions {
	/** Registry agent.json URL. Overridable for tests. */
	registryUrl?: string;
	/** Install root. Default ~/.local/opt/agy-acp. */
	installRoot?: string;
	/** Server settings dir. Default ~/.gemini/antigravity-acp. */
	geminiDir?: string;
	/** acp.bin from config (second resolution priority after AGY_ACP_BIN). */
	configBin?: string;
	/** Environment. Default process.env (test injection). */
	env?: NodeJS.ProcessEnv;
	/** Progress messages for the user (throttled by the caller's UI). */
	onProgress?: (msg: string) => void;
	fetchImpl?: typeof fetch;
	/** Archive unpacker. Default: `unzip` subprocess (tests inject a copier). */
	unpack?: (archive: string, dest: string) => Promise<void>;
	/** Download when the binary is missing. Default true. */
	install?: boolean;
}

export type AcpSetupStatus =
	| {
			ok: true;
			bin: string;
			binarySource: "env" | "config" | "installed" | "existing";
			auth: string;
			/** True when auth was just set to oauth-personal: the server opens
			 *  Google login in the browser on the first ACP message. */
			needsLogin: boolean;
			/** Human-readable actions taken (empty when everything was ready). */
			actions: string[];
	  }
	| { ok: false; stage: "install" | "auth"; error: string; manual: string };

export const MANUAL_SETUP = [
	"ACP manual setup:",
	"1. Download the server zip for your platform from the antigravity-acp",
	"   registry entry (github.com/agentclientprotocol/registry, folder",
	"   antigravity-acp/agent.json) and unzip it, e.g. to",
	"   ~/.local/opt/agy-acp/<build>/; chmod +x agy_acp_server.par.",
	"2. Point AGY_ACP_BIN or /agy config acp.bin at the binary",
	"   (~/.local/opt/agy-acp/current/agy_acp_server.par works; 'current' is a",
	"   symlink to the build dir).",
	'3. Log in: put {"auth":{"type":"oauth-personal"}} in',
	"   ~/.gemini/antigravity-acp/settings.json and complete the Google login that",
	"   opens in your browser on your first ACP message. That login IS your",
	"   Antigravity subscription: the same Google account and plan as the agy CLI.",
	"   Headless alternative (metered paid API, not the plan): GEMINI_API_KEY env",
	'   + {"auth":{"type":"gemini-api-key"}}.',
	"Details: /agy acp-auth",
].join("\n");

export function platformKey(): string {
	const goos = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	const goarch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return `${goos}-${goarch}`;
}

/** Build id from a registry archive URL:
 *  …/agy-acp-server-<build>-<platform>-<arch>.zip. */
export function buildIdFromArchive(url: string): string {
	const base = path.posix.basename(url, ".zip");
	const m = base.match(/^agy-acp-server-(.+)-(darwin|linux|windows)-(?:arm64|x86_64)$/);
	if (!m) throw new Error(`unrecognized registry archive name: ${base}`);
	return m[1];
}

function defaultInstallRoot(): string {
	return path.join(os.homedir(), ".local", "opt", "agy-acp");
}

function defaultGeminiDir(opts: SetupOptions): string {
	return opts.geminiDir ?? path.join(os.homedir(), ".gemini", "antigravity-acp");
}

/** Expand a leading ~ (spawn does not). Mirrors resolveAcpBinary. */
function expandTilde(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function executableFile(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

interface RegistryBinary {
	archive: string;
	cmd?: string;
}

async function fetchRegistryBinary(opts: SetupOptions, key: string): Promise<RegistryBinary> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const res = await fetchImpl(opts.registryUrl ?? REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`registry fetch failed: HTTP ${res.status}`);
	const json = (await res.json()) as { distribution?: { binary?: Record<string, RegistryBinary> } };
	const entry = json.distribution?.binary?.[key];
	if (!entry?.archive) throw new Error(`registry has no ${key} binary`);
	return entry;
}

function defaultUnpack(archive: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("unzip", ["-o", "-q", archive, "-d", dest], { stdio: "ignore" });
		child.on("error", (err) => reject(new Error(`unzip is not available: ${err.message}`)));
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited with ${code}`))));
	});
}

async function downloadTo(
	url: string,
	dest: string,
	fetchImpl: typeof fetch,
	onProgress?: (msg: string) => void,
): Promise<string> {
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
	const hash = createHash("sha256");
	const total = Number(res.headers.get("content-length") ?? 0);
	const out = fs.createWriteStream(dest);
	let done = 0;
	let lastPct = -1;
	for await (const chunk of res.body) {
		const buf = Buffer.from(chunk as unknown as Uint8Array);
		hash.update(buf);
		done += buf.length;
		if (total > 0) {
			const pct = Math.floor((done / total) * 100);
			if (pct >= lastPct + 10) {
				lastPct = pct;
				onProgress?.(`downloading ACP server: ${pct}%`);
			}
		}
		if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", r));
	}
	await new Promise<void>((resolve, reject) => {
		out.on("finish", () => resolve());
		out.on("error", reject);
		out.end();
	});
	return hash.digest("hex");
}

export interface InstallResult {
	bin: string;
	build: string;
	sha256: string;
	downloaded: boolean;
}

/** Fetch the pinned registry build for this platform and install it under
 *  <root>/<build>/ with a `current` symlink (plan §12). No-op when the
 *  build is already installed. Registry publishes no checksums; the zip
 *  sha256 is recorded at install time for drift detection. */
export async function installAcpBinary(opts: SetupOptions = {}): Promise<InstallResult> {
	const root = opts.installRoot ?? defaultInstallRoot();
	const entry = await fetchRegistryBinary(opts, platformKey());
	const build = buildIdFromArchive(entry.archive);
	const cmd = (entry.cmd ?? "./agy_acp_server.par").replace(/^\.\//, "");
	const dir = path.join(root, build);
	const bin = path.join(dir, cmd);
	if (executableFile(bin)) {
		return { bin, build, sha256: readRecordedSha(dir), downloaded: false };
	}

	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(dir, { recursive: true });
	const tmpZip = path.join(root, `.download-${build}.zip`);
	opts.onProgress?.(`downloading ACP server (build ${build})…`);
	const sha = await downloadTo(entry.archive, tmpZip, opts.fetchImpl ?? fetch, opts.onProgress);
	opts.onProgress?.("unpacking ACP server…");
	const unpack = opts.unpack ?? defaultUnpack;
	await unpack(tmpZip, dir);
	fs.rmSync(tmpZip, { force: true });
	if (!executableFile(bin)) throw new Error(`${cmd} not found in the archive after unpacking`);
	fs.chmodSync(bin, 0o755);
	fs.writeFileSync(path.join(dir, "zip.sha256"), `${sha}  ${path.basename(entry.archive)}\n`);

	// Re-point `current` at the new build. The link is ours (managed layout).
	const link = path.join(root, "current");
	fs.rmSync(link, { force: true });
	fs.symlinkSync(build, link);
	opts.onProgress?.("ACP server installed.");
	return { bin, build, sha256: sha, downloaded: true };
}

function readRecordedSha(dir: string): string {
	try {
		return fs.readFileSync(path.join(dir, "zip.sha256"), "utf8").split(/\s+/)[0] ?? "";
	} catch {
		return "";
	}
}

export interface AuthState {
	configured: boolean;
	/** settings.json auth.type, "token" (acp_token.json present), or undefined. */
	type?: string;
}

/** Auth state WITHOUT reading any credential value: settings.json carries
 *  only auth.type (+ non-secret gcp placement), acp_token.json is stat()ed. */
export function readAuthState(dir?: string): AuthState {
	const target = dir ?? path.join(os.homedir(), ".gemini", "antigravity-acp");
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8")) as {
			auth?: { type?: unknown };
		};
		const type = typeof raw.auth?.type === "string" ? raw.auth.type : undefined;
		if (type) return { configured: true, type };
	} catch {
		/* absent or garbage = unconfigured */
	}
	try {
		fs.statSync(path.join(target, "acp_token.json"));
		return { configured: true, type: "token" };
	} catch {
		return { configured: false };
	}
}

/** Write a minimal auth block into settings.json. The server reads this file
 *  at STARTUP, so this must happen before the first server spawn. */
export function writeAuthType(type: "gemini-api-key" | "oauth-personal", dir?: string): void {
	const target = dir ?? path.join(os.homedir(), ".gemini", "antigravity-acp");
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	const file = path.join(target, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		/* fresh file */
	}
	const prevAuth = (typeof settings.auth === "object" && settings.auth !== null ? settings.auth : {}) as Record<string, unknown>;
	fs.writeFileSync(file, `${JSON.stringify({ ...settings, auth: { ...prevAuth, type } }, null, 2)}\n`, { mode: 0o600 });
}

export interface BinaryResolution {
	bin: string | null;
	source: "env" | "config" | "existing" | "installed" | null;
}

/** Read-only binary resolution: AGY_ACP_BIN > acp.bin > installed `current`
 *  layout. Does NOT install and does NOT fall back to the bare PATH name. */
export function resolveInstalledBinary(opts: SetupOptions = {}): BinaryResolution {
	const env = opts.env ?? process.env;
	const root = opts.installRoot ?? defaultInstallRoot();
	const candidates: Array<[string, BinaryResolution["source"]]> = [
		[env.AGY_ACP_BIN?.trim() ?? "", "env"],
		[opts.configBin?.trim() ?? "", "config"],
		[path.join(root, "current", "agy_acp_server.par"), "existing"],
	];
	for (const [raw, source] of candidates) {
		if (!raw) continue;
		const bin = expandTilde(raw);
		if (executableFile(bin)) return { bin, source };
	}
	return { bin: null, source: null };
}

/** Read-only setup state (for /agy doctor): no installs, no writes. */
export function inspectAcpSetup(opts: SetupOptions = {}): { bin: string | null; source: string | null; auth: string | null } {
	const binary = resolveInstalledBinary(opts);
	const auth = readAuthState(defaultGeminiDir(opts));
	return { bin: binary.bin, source: binary.source, auth: auth.configured ? (auth.type ?? "token") : null };
}

/** Orchestrate everything the ACP engine needs, in order: binary (install
 *  from the registry when missing), then auth (oauth-personal: the user's
 *  own Antigravity subscription - the same Google account and plan as the
 *  agy CLI login; the server opens the browser itself on the first message).
 *  Every step is skipped when already satisfied; failures return `manual`
 *  text for the caller to surface. */
export async function ensureAcpReady(opts: SetupOptions = {}): Promise<AcpSetupStatus> {
	const actions: string[] = [];

	// 1. Binary.
	let binary = resolveInstalledBinary(opts);
	if (!binary.bin) {
		if (opts.install === false) {
			return { ok: false, stage: "install", error: "no ACP server binary found", manual: MANUAL_SETUP };
		}
		try {
			const installed = await installAcpBinary(opts);
			binary = { bin: installed.bin, source: "installed" };
			actions.push(installed.downloaded ? `installed ACP server build ${installed.build}` : `found installed ACP server build ${installed.build}`);
		} catch (err) {
			return {
				ok: false,
				stage: "install",
				error: err instanceof Error ? err.message : String(err),
				manual: MANUAL_SETUP,
			};
		}
	}

	// 2. Auth. settings.json is read at server STARTUP; setup always runs
	// before the first spawn, so a fresh write takes effect. oauth-personal is
	// THE default: it is the Antigravity subscription (same Google account and
	// plan as the agy CLI login). gemini-api-key (metered paid API) stays a
	// manual option for headless boxes (/agy acp-auth); never the default.
	const gdir = defaultGeminiDir(opts);
	const auth = readAuthState(gdir);
	if (!auth.configured) {
		try {
			writeAuthType("oauth-personal", gdir);
			actions.push("configured oauth-personal auth (your Antigravity subscription login)");
			return { ok: true, bin: binary.bin!, binarySource: binary.source!, auth: "oauth-personal", needsLogin: true, actions };
		} catch (err) {
			return {
				ok: false,
				stage: "auth",
				error: err instanceof Error ? err.message : String(err),
				manual: MANUAL_SETUP,
			};
		}
	}
	return {
		ok: true,
		bin: binary.bin!,
		binarySource: binary.source!,
		auth: auth.type ?? "token",
		needsLogin: false,
		actions,
	};
}
