// Mock-API smoke test: load the extension entry point with a fake ExtensionAPI
// and assert registerProvider is called with the right shape. No agy spawn, no
// pi TUI  -  just confirms the wiring (model discovery fallback + provider
// registration) is sound. Catches import errors and malformed registrations
// before the user installs the extension.
//
// Usage: npx tsx scripts/test-extension.ts

import { FALLBACK_MODELS, toPiModel } from "../src/models.js";

// Minimal mock of the ExtensionAPI surface the extension touches.
function withMockApi<T>(fn: (api: MockApi) => Promise<T>): { result: Promise<T>; getRegistered: () => unknown; getCommand: () => unknown; getTools: () => Array<{ name: string; def: Record<string, unknown> }> } {
	let registered: unknown = null;
	let command: unknown = null;
	const tools: Array<{ name: string; def: Record<string, unknown> }> = [];
	const api: MockApi = {
		registerProvider(id: string, config: Record<string, unknown>) {
			registered = { id, config };
		},
		registerCommand(name: string, def: Record<string, unknown>) {
			command = { name, def };
		},
		registerTool(def: Record<string, unknown>) {
			tools.push({ name: def.name as string, def });
		},
		on(_event: string, _fn: (...args: unknown[]) => unknown) {},
	};
	return { result: fn(api), getRegistered: () => registered, getCommand: () => command, getTools: () => tools };
}

interface MockApi {
	registerProvider(id: string, config: Record<string, unknown>): void;
	registerCommand(name: string, def: Record<string, unknown>): void;
	registerTool(def: Record<string, unknown>): void;
	on(event: string, fn: (...args: unknown[]) => unknown): void;
}

// Import the extension default export. tsx resolves the relative path; the
// extension's `@earendil-works/*` imports resolve from node_modules.
const extModule = await import("../extensions/index.js");
const ext = extModule.default;

const { result, getRegistered, getCommand, getTools } = withMockApi((api) => ext(api as never));

// The extension's default export is async; agy discovery is bounded and may
// return [] (e.g. agy not on PATH in CI)  -  the fallback catalog must still
// populate the picker.
await result;
const registered = getRegistered() as { id: string; config: Record<string, unknown> } | null;
const command = getCommand() as { name: string; def: Record<string, unknown> } | null;
const tools = getTools();
const askTool = tools.find((t) => t.name === "AskAntigravity") ?? null;

let failures = 0;
const check = (label: string, cond: boolean) => {
	if (!cond) failures++;
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
};

console.log("extension load smoke test");
check("registerProvider was called", registered !== null);
check("registerCommand was called for /agy", command !== null && command.name === "agy");
check("registerTool called for AskAntigravity", askTool !== null && askTool.name === "AskAntigravity");
if (registered) {
	check("provider id is 'antigravity'", registered.id === "antigravity");
	const cfg = registered.config;
	check("config has streamSimple", typeof cfg.streamSimple === "function");
	check("config has models array", Array.isArray(cfg.models));
	const models = cfg.models as Array<{ id: string; name: string }>;
	check(
		`models populated (got ${models.length}, fallback has ${FALLBACK_MODELS.length})`,
		models.length >= FALLBACK_MODELS.length,
	);
	if (models.length > 0) {
		const ids = models.map((m) => m.id).join(", ");
		console.log(`       registered model ids: ${ids}`);
		// The fallback models must project cleanly through toPiModel.
		const projected = FALLBACK_MODELS.map((e) => toPiModel(e));
		check("fallback models all project provider=antigravity", projected.every((m) => m.provider === "antigravity"));
	}
	// Subagent guard: a second load must NOT re-register (Symbol.for global).
	// Reset and reload; registered should stay null the second time because
	// the guard short-circuits.
}

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
