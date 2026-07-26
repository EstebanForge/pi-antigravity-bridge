// Narration filtering. agy interleaves short "I will ..." planning lines into
// the agent text stream before the real answer. In a streaming provider those
// chunks are noise  -  they narrate intent ("I will read the file") instead of
// answering. This drops narration-only lines so pi's transcript reads as prose.
//
// Ported from shindgew/agy-acp src/agy/db/narration.ts. The prefix list covers
// the straight and curly apostrophe forms agy emits.
//
// Precision: a line is narration only when it is a short intent statement
// of the form "I will/I'll <agentic verb> ..."  -  i.e. the model stating a
// tool or file/code action it is about to take. Substantive answers that
// merely begin with "I will" are preserved: explanations ("I will explain ..."),
// assumptions ("I'll assume ..."), opinions ("I'll disagree"). The verb set
// below is the doing/saying split; there is no length ceiling, because a line
// of the form "I will <action verb> ..." is intent at any length.
//
// Chunk alignment: this filter judges whole lines. provider.ts line-buffers
// streaming deltas and classifies each complete line individually, so a
// narration line that grows across ticks is decided once (after its trailing
// newline) and never leaks a partial tail. Users who hit an edge case can
// disable the filter: /agy narration off.

const NARRATION_PREFIXES = ["I will", "I'll", "I\u2019ll"];

// Agentic verbs agy emits when narrating an imminent tool or file/code action.
// A line starting with "I will/I'll" is treated as narration only when the word
// right after the prefix is one of these. Verbs of saying/explaining are
// deliberately absent, so substantive answers beginning with "I will" survive.
const NARRATION_VERBS = new Set([
	"add", "apply", "build", "change", "check", "create", "delete", "edit",
	"examine", "execute", "fetch", "find", "fix", "format", "grep", "implement",
	"inspect", "install", "lint", "list", "look", "modify", "open", "read",
	"refactor", "remove", "replace", "run", "search", "test", "update", "verify",
	"view", "write",
]);

// Narration lines are short intent statements in practice, but length is not
// part of the signal: "I will <agentic verb> ..." is intent at any length, and
// a real answer almost never starts with that shape.

/** True if every non-empty line in `text` is a narration line: an intent
 *  statement of the form "I will/I'll <agentic verb> ...". Empty text is not
 *  narration. Substantive answers that merely start with "I will" (explanations,
 *  assumptions, opinions) are preserved. */
export function isNarration(text: string): boolean {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return false;
	return lines.every(isNarrationLine);
}

/** Classify a single line (no embedded newline) as narration. Exported for
 *  direct unit testing of the verb/length logic. */
export function isNarrationLine(raw: string): boolean {
	const line = raw.replace(/^\s+/, "");
	// Prefix must be followed by a word boundary so "I willpower ..." or
	// "I'llx" don't false-match the prefix.
	const prefix = NARRATION_PREFIXES.find(
		(p) => line.startsWith(p) && (line.length === p.length || /\s/.test(line[p.length])),
	);
	if (!prefix) return false;
	// First word after the prefix, lowercased, trailing punctuation stripped.
	// "I will read the file." -> "read"; "I'll check the logs:" -> "check".
	const rest = line.slice(prefix.length).trimStart().toLowerCase();
	const verb = (rest.split(/\s+/)[0] ?? "").replace(/[^a-z].*$/, "");
	if (!verb) return false; // bare "I will" with nothing after -> keep
	return NARRATION_VERBS.has(verb);
}
