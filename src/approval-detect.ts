// Third-party pi permission-extension detection for the approval gate
// (docs/TODO.md 2.5). The gate defaults to "auto": OFF until one of these
// extensions is present. Detection reads pi's settings (the packages array
// is the primary, name-exact signal) plus known on-disk config markers for
// the audited permission packages (sources: ~/tmp/pi-perm-research/, audit
// 2026-09-07). Best effort by design: a miss only means the user enables
// the gate manually; a false positive stages hooks.json, which is inert
// unless the ACP/CLI server loads it, and observation-only hooks are safe.
//
// Run: npm test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** npm names of the audited pi permission packages (docs/TODO.md 2.4). */
export const KNOWN_GATE_PACKAGES = [
	"@gotgenes/pi-permission-system",
	"@zhushanwen/pi-permission",
	"pi-permission-system",
	"@xzzpig/pi-permission-system",
	"@diegopetrucci/pi-permission-gate",
	"pi-permission-modes",
	"@inobit/pi-permission",
	"@thurstonsand/pi-permissions",
	"@monroewilliams/pi-permission-system",
	"@rhedbull/pi-permissions",
] as const;

export interface GateExtensionHit {
	/** The known package name matched. */
	name: string;
	/** How it was detected: "settings:<path>" or "config:<path>". */
	evidence: string;
}

function readJsonIfPresent(file: string): { packages?: unknown } | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function packagesFrom(settingsFile: string): string[] {
	const parsed = readJsonIfPresent(settingsFile);
	const raw = parsed?.packages;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string");
}

function nameMatchesPackage(entry: string): string | undefined {
	// entries look like "npm:@scope/name@1.2.3", "git:...", or a bare path.
	// Boundary-aware match: the known name must start after :/@ (or the
	// string start) and must not be a prefix of a longer package name
	// ("pi-permission-system-clone" must NOT match). Version suffix @x.y is
	// fine. Peer review 2026-09-07 finding 4.
	const lower = entry.toLowerCase();
	let best: string | undefined;
	for (const name of KNOWN_GATE_PACKAGES) {
		if (containsName(lower, name) && (best === undefined || name.length > best.length)) best = name;
	}
	// Longest match wins: "@xzzpig/pi-permission-system" must resolve to the
	// scoped name, not to the shorter unscoped fork "pi-permission-system".
	return best;
}

function containsName(lower: string, name: string): boolean {
	let idx = lower.indexOf(name);
	while (idx >= 0) {
		const before = idx === 0 ? "" : lower[idx - 1];
		const after = lower[idx + name.length] ?? "";
		const okBefore = before === "" || ":/@".includes(before);
		const okAfter = after === "" || after === "@" || !/[a-z0-9_-]/.test(after);
		if (okBefore && okAfter) return true;
		idx = lower.indexOf(name, idx + 1);
	}
	return false;
}

/**
 * Detect installed third-party permission extensions.
 *
 * @param opts.home  HOME override for tests.
 * @param opts.cwd   project dir override for tests (project settings).
 * @param opts.settingsFiles  extra settings files to scan (tests).
 */
export function detectPermissionGateExtensions(
	opts: { home?: string; cwd?: string; settingsFiles?: string[] } = {},
): GateExtensionHit[] {
	const home = opts.home ?? os.homedir();
	const cwd = opts.cwd ?? process.cwd();
	const hits: GateExtensionHit[] = [];
	const seen = new Set<string>();

	const settingsCandidates = [
		...(opts.settingsFiles ?? []),
		path.join(home, ".pi", "agent", "settings.json"),
		path.join(cwd, ".pi", "settings.json"),
	];
	for (const file of settingsCandidates) {
		for (const entry of packagesFrom(file)) {
			const name = nameMatchesPackage(entry);
			if (name && !seen.has(name)) {
				seen.add(name);
				hits.push({ name, evidence: `settings:${file}` });
			}
		}
	}

	// Known config-file markers from the audit. Presence of the config does
	// not prove the extension is installed, but every audited package writes
	// its config only after install + first run, which is evidence enough for
	// an opt-in default.
	const markers: Array<{ file: string; name: string }> = [
		{ file: path.join(home, ".pi", "agent", "extensions", "pi-permission-system"), name: "@gotgenes/pi-permission-system" },
		{ file: path.join(home, ".agent", "pi-permissions.jsonc"), name: "@monroewilliams/pi-permission-system" },
		{ file: path.join(home, ".pi", "agent", "extensions", "permissions.json"), name: "@rhedbull/pi-permissions" },
		{ file: path.join(cwd, ".pi", "agent", "pi-permissions.jsonc"), name: "@gotgenes/pi-permission-system" },
	];
	for (const marker of markers) {
		if (!seen.has(marker.name)) {
			try {
				fs.statSync(marker.file);
				seen.add(marker.name);
				hits.push({ name: marker.name, evidence: `config:${marker.file}` });
			} catch {
				/* absent - fine */
			}
		}
	}

	return hits;
}

/** Resolve the effective gate shape from config + detection. "auto" defers
 *  to detection (shadow when any gate extension is present, else off). */
export function resolveGateMode(
	gateMode: "auto" | "shadow" | "dedicated" | "off",
	hits: GateExtensionHit[],
): "shadow" | "dedicated" | "off" {
	if (gateMode === "off") return "off";
	if (gateMode === "shadow" || gateMode === "dedicated") return gateMode;
	return hits.length > 0 ? "shadow" : "off";
}
