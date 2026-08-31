// Native re-execution mapping - agy read-only tools whose work pi can redo
// cheaply and safely with its own builtins. The provider emits these as native
// pi toolCalls (real builtin name, pi-schema args); pi executes the real
// builtin, so cards render with pi's own renderers.
//
// Mutating tools (commands, edits, writes) and agy-specialty tools are never
// re-executed - they replay through the display-only `antigravity` wrapper
// tool. Ported from tianzuo/pi-antigravity lib/native-tools.ts (MIT).

export interface NativeToolCall {
	/** pi builtin tool name (`read`, `ls`, `grep`, `find`). */
	tool: string;
	/** Arguments conforming to the builtin's schema. */
	args: Record<string, unknown>;
}

function str(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function num(input: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
	const accepted = new Set(allowed);
	return Object.entries(input).every(
		([key, value]) => value === undefined || value === null || accepted.has(key),
	);
}

const VIEW_PATH_KEYS = [
	"path",
	"Path",
	"AbsolutePath",
	"absolute_path",
	"TargetFile",
	"target_file",
	"FilePath",
	"file_path",
] as const;
const START_LINE_KEYS = ["StartLine", "start_line", "startLine"] as const;
const END_LINE_KEYS = ["EndLine", "end_line", "endLine"] as const;

/** Map an agy tool step to a native pi toolCall when re-execution is safe.
 *  Returns undefined for everything that must stay on the replay wrapper. */
export function mapAgyToolToNative(
	tool: string,
	args: Record<string, unknown>,
): NativeToolCall | undefined {
	switch (tool) {
		case "view_file": {
			if (!onlyKeys(args, [...VIEW_PATH_KEYS, ...START_LINE_KEYS, ...END_LINE_KEYS])) {
				return undefined;
			}
			const path = str(args, [...VIEW_PATH_KEYS]);
			const start = num(args, [...START_LINE_KEYS]);
			const end = num(args, [...END_LINE_KEYS]);
			if (!path || (end !== undefined && start === undefined) || (start && end && end < start)) {
				return undefined;
			}
			return {
				tool: "read",
				args: {
					path,
					...(start === undefined ? {} : { offset: start }),
					...(start === undefined || end === undefined ? {} : { limit: end - start + 1 }),
				},
			};
		}
		case "list_dir": {
			const keys = ["path", "Path", "DirectoryPath", "directory", "Directory"];
			if (!onlyKeys(args, keys)) return undefined;
			const path = str(args, keys);
			return path ? { tool: "ls", args: { path } } : undefined;
		}
		case "grep_search": {
			const patternKeys = ["query", "Query", "pattern", "Pattern"];
			const pathKeys = ["search_path", "SearchPath", "path", "Path"];
			if (!onlyKeys(args, [...patternKeys, ...pathKeys])) return undefined;
			const pattern = str(args, patternKeys);
			const path = str(args, pathKeys);
			return pattern ? { tool: "grep", args: path ? { pattern, path } : { pattern } } : undefined;
		}
		case "find_by_name": {
			const patternKeys = ["pattern", "Pattern", "glob", "name"];
			const pathKeys = ["search_directory", "SearchDirectory", "path", "Path", "directory"];
			if (!onlyKeys(args, [...patternKeys, ...pathKeys])) return undefined;
			const pattern = str(args, patternKeys);
			const path = str(args, pathKeys);
			return pattern ? { tool: "find", args: path ? { pattern, path } : { pattern } } : undefined;
		}
		default:
			return undefined;
	}
}
