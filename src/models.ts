// Discover Gemini models from `agy models` and project them into pi's Model
// shape so they appear in the /model picker as antigravity/<slug>.
//
// agy prints one model per line, e.g.:
//   Gemini 3.6 Flash (Medium)
//   Gemini 3.1 Pro (High)
//   Claude Sonnet 4.6 (Thinking)
//   GPT-OSS 120B (Medium)
//
// We keep ONLY Gemini models here  -  Claude and GPT-OSS belong to other
// providers (pi-claude-bridge, etc.). Driving them through agy would double-
// bill and conflict with the user's other subscriptions.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

const DISCOVERY_TIMEOUT_MS = 8_000;

export interface AgyModelEntry {
	/** Exact agy string, e.g. "Gemini 3.6 Flash (Medium)". */
	full: string;
	/** pi model id, e.g. "gemini-3-6-flash-medium". */
	id: string;
}

/** Spawn `agy models` and return its raw stdout text. Returns "" on any
 *  failure (non-zero exit, spawn error, or watchdog timeout). Bounded by
 *  DISCOVERY_TIMEOUT_MS so a hung agy (auth prompt, network stall) can't
 *  block extension load. Shared by the provider and the tool catalog so the
 *  extension spawns `agy models` ONCE per load. */
export async function spawnAgyModelsRaw(binary: string): Promise<string> {
	try {
		return await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["models"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => (out += d));
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
	} catch {
		return "";
	}
}

// --- catalog cache ----------------------------------------------------------
//
// `agy models` can take seconds (OAuth refresh, cold start) and its output
// rarely changes. We persist it to ~/.pi/agent/antigravity-bridge/models-
// cache.json with a short TTL so reloads serve instantly and only re-spawn in
// the background when stale. Only successful (non-empty) output is cached, so
// a broken agy is never sticky.

export const MODELS_CACHE_TTL_MS = 5 * 60_000;

const MODELS_CACHE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"antigravity-bridge",
	"models-cache.json",
);

interface ModelsCache {
	raw: string;
	savedAt: number;
}

/** Read and validate the models cache. Returns null when missing or corrupt. */
function readModelsCache(cachePath: string = MODELS_CACHE_PATH): ModelsCache | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			typeof (parsed as ModelsCache).raw === "string" &&
			typeof (parsed as ModelsCache).savedAt === "number"
		) {
			return parsed as ModelsCache;
		}
	} catch {
		/* missing or corrupt: treat as no cache */
	}
	return null;
}

/** Atomically persist the raw catalog text (temp + rename, mode 0o600).
 *  Best-effort: a write failure just means the next load re-spawns. */
function writeModelsCache(raw: string, cachePath: string = MODELS_CACHE_PATH): void {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ raw, savedAt: Date.now() }, null, 2) + "\n", {
			mode: 0o600,
		});
		fs.renameSync(tmp, cachePath);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
	}
}

/** Fire-and-forget refresh of the models cache. Called on a stale-cache load so
 *  the next load sees fresh data without this one having to wait on agy. */
export function refreshModelsInBackground(
	binary: string,
	cachePath: string = MODELS_CACHE_PATH,
): void {
	void spawnAgyModelsRaw(binary)
		.then((raw) => {
			if (raw) writeModelsCache(raw, cachePath);
		})
		.catch(() => {
			/* best effort: leave the stale cache in place */
		});
}

/** Load the raw `agy models` text for catalog derivation, optimized for load
 *  time:
 *    - Fresh cache (< MODELS_CACHE_TTL_MS): return it, no spawn.
 *    - Stale cache (>= TTL): return it instantly, refresh in the background.
 *    - No cache: spawn once (blocks), persist. First-ever load only.
 *
 *  pi registers providers with a static model list, so a background refresh only
 *  updates the cache for the NEXT load; the current session keeps whatever this
 *  returned. The provider falls back to FALLBACK_MODELS when the raw yields no
 *  Gemini entries (agy missing/auth-failed). */
export async function loadModelCatalogRaw(
	binary: string,
	cachePath: string = MODELS_CACHE_PATH,
): Promise<string> {
	const cache = readModelsCache(cachePath);
	if (cache) {
		if (Date.now() - cache.savedAt < MODELS_CACHE_TTL_MS) return cache.raw;
		refreshModelsInBackground(binary, cachePath);
		return cache.raw;
	}
	// No cache: populate it. Blocks once; later loads hit the cache above.
	const raw = await spawnAgyModelsRaw(binary);
	if (raw) writeModelsCache(raw, cachePath);
	return raw;
}

/** Parse raw `agy models` text into the provider's slugified Gemini entries. */
export function entriesFromRaw(raw: string): AgyModelEntry[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter(isGeminiModel)
		.map((full) => ({ full, id: slugify(full) }))
		.filter((e): e is AgyModelEntry => e.id.length > 0);
}

/** Run `agy models`, return parsed Gemini entries. Returns [] on any failure
 *  (non-fatal  -  the provider falls back to a hardcoded set). */
export async function discoverAgyModels(binary: string): Promise<AgyModelEntry[]> {
	return entriesFromRaw(await spawnAgyModelsRaw(binary));
}

/** Gemini models only. Case-insensitive: the name must contain "gemini" and
 *  NOT be a Claude/GPT-OSS entry (defensive  -  agy could rename lines). */
function isGeminiModel(line: string): boolean {
	const l = line.toLowerCase();
	if (!l.includes("gemini")) return false;
	if (l.includes("claude")) return false;
	if (l.includes("gpt")) return false;
	return true;
}

/** "Gemini 3.6 Flash (Medium)" -> "gemini-3-6-flash-medium".
 *  Lowercase, non-alphanumerics -> "-", collapsed, trimmed. */
export function slugify(full: string): string {
	return full
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Project an agy entry to pi's Model shape. */
export function toPiModel(entry: AgyModelEntry): Model<Api> {
	const tier = /\(high\)/i.test(entry.full)
		? "high"
		: /\(low\)/i.test(entry.full)
			? "low"
			: "medium";
	// "reasoning" gates pi's thinking-effort UI. Gemini reasons at every tier,
	// but we only expose the toggle for High to avoid implying control we
	// don't actually bridge to agy.
	const reasoning = tier === "high";
	return {
		id: entry.id,
		name: entry.full,
		api: "agy-bridge" as Api,
		provider: "antigravity",
		// baseUrl/apiKey are not used (streamSimple intercepts everything), but
		// pi requires non-empty values. The "agy-bridge" api string is a custom
		// sentinel that no built-in provider claims, so it can never collide.
		baseUrl: "agy-bridge://antigravity",
		reasoning,
		// agy's -p prompt is text-only. Advertising image input would let pi
		// offer image attach, but extractUserPrompt silently drops image blocks,
		// so the user would be misled. Keep input text-only until agy supports
		// image passthrough in print mode.
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Gemini long context. agy doesn't expose the real per-model window in
		// `agy models`; 1M is the documented Gemini ceiling.
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

/** Fallback catalog used when `agy models` fails at load (binary missing,
 *  auth not yet done, network stall). Keeps the picker populated so the user
 *  can still select a model and get a clear runtime error instead of an empty
 *  list. Update these when agy ships new Gemini versions. */
export const FALLBACK_MODELS: AgyModelEntry[] = [
	{ full: "Gemini 3.6 Flash (Medium)", id: "gemini-3-6-flash-medium" },
	{ full: "Gemini 3.6 Flash (High)", id: "gemini-3-6-flash-high" },
	{ full: "Gemini 3.1 Pro (High)", id: "gemini-3-1-pro-high" },
];

/** Resolve a pi model id back to the exact agy string. O(n) over a small list
 *   -  the provider calls this once per turn. Returns null on miss (caller
 *  falls back to passthrough, agy will likely reject). */
export function resolveAgyString(
	piModelId: string,
	entries: AgyModelEntry[],
): string | null {
	const found = entries.find((e) => e.id === piModelId);
	return found ? found.full : null;
}
