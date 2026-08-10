// Discover models from `agy models` and project them into pi's Model shape so
// they appear in the /model picker as antigravity/<slug>.
//
// agy prints TWO columns per line: "<slug>  <display label>". --model takes
// ONLY the slug (col 1); the label is display-only. Verified live, e.g.:
//   gemini-3.6-flash-high     Gemini 3.6 Flash (High)
//   gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)   (+ -low)
//   gemini-3.1-pro-high       Gemini 3.1 Pro (High)        (Pro has NO medium)
//   claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking) (fixed, no tiers)
//   gpt-oss-120b-medium       GPT-OSS 120B (Medium)        (fixed, no tiers)
//
// Gemini models are collapsed to a BASE slug (gemini-3.6-flash) and exposed
// with a thinking-effort toggle whose levels match exactly the tiers agy
// offers that base (verified: Pro rejects medium). The picked level is sent as
// agy --effort; a base slug is INVALID on its own, so effort is always passed.
// Claude and GPT-OSS keep agy's exact slug with no toggle: their thinking is
// fixed and agy rejects --effort for them. Google's Antigravity subscription
// bills all of these through agy.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

const DISCOVERY_TIMEOUT_MS = 8_000;

/** Reasoning-effort tiers agy accepts via --effort. */
export type AgyEffort = "low" | "medium" | "high";

/** low < medium < high, for sorting/clamping. */
const EFFORT_RANK: Record<AgyEffort, number> = { low: 0, medium: 1, high: 2 };

/** Split an agy slug into (base, tier). tier is null when the slug has no
 *  -high/-medium/-low suffix (claude-sonnet-4-6, gpt-oss-120b-medium's "medium"
 *  IS its suffix here, claude-opus-4-6-thinking is not a tier). */
const TIER_RE = /^(.+)-(high|medium|low)$/;

/** agy emits clean slug ids (gemini-3.6-flash-high). Validate col1 of each
 *  line so a banner / auth / "Fetching models…" line can't register as a
 *  model, and a leading-dash token (e.g. "-high") can't reach agy's flag
 *  parser as --model. First char must be alphanumeric; the slug must contain
 *  at least one hyphen (every real agy slug does: family-version-name), which
 *  also drops a prose banner word split out of col1 ("Available"). */
const MODEL_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;

/** Model families VERIFIED to accept base-slug + --effort. Only these collapse
 *  to a base slug with a thinking toggle. Any other family stays as agy's exact
 *  qualified slug (always valid on its own), so an unknown or fixed-thinking
 *  family degrades safely instead of forcing an unsupported --effort. Add a
 *  family here only after confirming base+--effort is accepted for it. */
const EFFORT_CAPABLE_FAMILIES: readonly RegExp[] = [/^gemini-/];

export interface AgyModelEntry {
	/** Exact agy --model string to pass: a base slug ("gemini-3.6-flash") when
	 *  effort-driven, else agy's full qualified slug ("claude-opus-4-6-thinking"). */
	full: string;
	/** pi model id, e.g. "gemini-3-6-flash". */
	id: string;
	/** Present iff this is an effort-driven base slug. Lists the tiers agy
	 *  accepts for it; pi's thinking toggle picks among them and we always pass
	 *  --effort. Absent => fixed model, never pass --effort. */
	efforts?: AgyEffort[];
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

/** Parse raw `agy models` text into the provider's model entries.
 *
 *  Effort-driven Gemini bases (>= 2 tier variants in the catalog) collapse to
 *  one BASE-slug entry carrying the tiers they accept. Models with 0 or 1 tier
 *  variants keep agy's exact qualified slug: a single suffix (gpt-oss-120b-
 *  medium) or none (claude-sonnet-4-6) means fixed thinking, where --effort is
 *  unsupported. Insertion order of first-seen bases is preserved. */
export function entriesFromRaw(raw: string): AgyModelEntry[] {
	// agy prints TWO columns: "<slug>  <display label>". --model takes only the
	// slug, so split col1 and validate THAT; the label is display-only. A
	// bare-slug line (no whitespace) splits to itself, so this also tolerates
	// the legacy one-column shape.
	const groups = new Map<string, { lines: string[]; tiers: Set<AgyEffort> }>();
	for (const line of raw.split("\n")) {
		const slug = line.trim().split(/\s+/)[0] ?? "";
		if (!slug || !MODEL_LINE_RE.test(slug)) continue;
		const m = TIER_RE.exec(slug);
		const base = m ? (m[1] as string) : slug;
		const tier = m ? (m[2] as AgyEffort) : null;
		let g = groups.get(base);
		if (!g) {
			g = { lines: [], tiers: new Set<AgyEffort>() };
			groups.set(base, g);
		}
		g.lines.push(slug);
		if (tier) g.tiers.add(tier);
	}
	const entries: AgyModelEntry[] = [];
	for (const [base, g] of groups) {
		const efforts = [...g.tiers].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
		if (efforts.length >= 2 && EFFORT_CAPABLE_FAMILIES.some((re) => re.test(base))) {
			entries.push({ full: base, id: slugify(base), efforts });
		} else {
			for (const line of g.lines) entries.push({ full: line, id: slugify(line) });
		}
	}
	return entries.filter((e) => e.id.length > 0);
}

/** Run `agy models`, return parsed model entries. Returns [] on any failure
 *  (non-fatal  -  the provider falls back to a hardcoded set). */
export async function discoverAgyModels(binary: string): Promise<AgyModelEntry[]> {
	return entriesFromRaw(await spawnAgyModelsRaw(binary));
}

/** "Gemini 3.6 Flash (Medium)" -> "gemini-3-6-flash-medium".
 *  Lowercase, non-alphanumerics -> "-", collapsed, trimmed. */
export function slugify(full: string): string {
	return full
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Build the thinkingLevelMap for an effort-driven base: hide "off" and
 *  "minimal" always (agy has no no-thinking mode; a base REQUIRES an effort),
 *  and hide any of low/medium/high the base doesn't offer (e.g. Pro has no
 *  medium). pi's getSupportedThinkingLevels treats a null value as hidden, so
 *  the toggle then shows exactly agy's slider stops. */
function thinkingLevelMapFor(efforts: readonly AgyEffort[]): ThinkingLevelMap {
	const map: Record<string, string | null> = { off: null, minimal: null };
	for (const level of ["low", "medium", "high"] as const) {
		if (!efforts.includes(level)) map[level] = null;
	}
	return map as ThinkingLevelMap;
}

/** Project an agy entry to pi's Model shape. */
export function toPiModel(entry: AgyModelEntry): Model<Api> {
	const effortDriven = !!entry.efforts && entry.efforts.length > 0;
	return {
		id: entry.id,
		name: entry.full,
		api: "agy-bridge" as Api,
		provider: "antigravity",
		// baseUrl/apiKey are not used (streamSimple intercepts everything), but
		// pi requires non-empty values. The "agy-bridge" api string is a custom
		// sentinel that no built-in provider claims, so it can never collide.
		baseUrl: "agy-bridge://antigravity",
		// reasoning=true only for effort-driven bases => pi shows the toggle.
		// Fixed models (Claude/GPT-OSS) get no toggle: their thinking can't be
		// changed and agy rejects --effort for them.
		reasoning: effortDriven,
		...(effortDriven ? { thinkingLevelMap: thinkingLevelMapFor(entry.efforts!) } : {}),
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
	{ full: "gemini-3.6-flash", id: "gemini-3-6-flash", efforts: ["low", "medium", "high"] },
	{ full: "gemini-3.1-pro", id: "gemini-3-1-pro", efforts: ["low", "high"] },
	{ full: "claude-sonnet-4-6", id: "claude-sonnet-4-6" },
];


