// pi Agent Skills catalog + activate_skill bridge.
//
// The MCP bridge exposes ONE `activate_skill` tool to agy whose JSON-schema
// enum is the catalog; the description carries each skill's one-liner so agy
// can tell when a skill applies. Calling it returns the full SKILL.md plus the
// bundled resource dir. Nothing is appended to the prompt: agy sees the
// catalog in tools/list on every spawn, including after pi compaction.
// Shape borrowed from tianzuo/pi-antigravity lib/skills.ts (MIT).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

export interface SkillLite {
	name: string;
	description: string;
	/** Absolute path to SKILL.md. */
	filePath: string;
	/** Absolute directory containing SKILL.md and bundled resources. */
	dir: string;
}

/** Parse `name:` / `description:` out of SKILL.md frontmatter. */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of m[1].split(/\r?\n/)) {
		const name = line.match(/^name:\s*(.+)$/);
		if (name && !out.name) out.name = name[1].trim();
		const desc = line.match(/^description:\s*(.+)$/);
		if (desc && !out.description) out.description = desc[1].trim();
	}
	return out;
}

function scanDir(dir: string): SkillLite[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
	} catch {
		return [];
	}
	const found: SkillLite[] = [];
	for (const entry of entries) {
		const skillDir = path.join(dir, entry);
		const skillFile = path.join(skillDir, "SKILL.md");
		try {
			if (!fs.statSync(skillFile).isFile()) continue;
		} catch {
			continue;
		}
		let raw = "";
		try {
			raw = fs.readFileSync(skillFile, "utf8");
		} catch {
			continue;
		}
		const fm = parseFrontmatter(raw);
		found.push({
			name: fm.name?.trim() || entry,
			description: (fm.description ?? "").replace(/\s+/g, " ").slice(0, 160),
			filePath: skillFile,
			dir: skillDir,
		});
	}
	return found;
}

/** Unique skills with a file path; first name wins (same as pi collisions). */
export function scanSkills(projectDir?: string): SkillLite[] {
	const globalDir = path.join(os.homedir(), ".pi", "agent", "skills");
	const seen = new Set<string>();
	const out: SkillLite[] = [];
	for (const skill of [...scanDir(globalDir), ...(projectDir ? scanDir(path.join(projectDir, ".pi", "skills")) : [])]) {
		if (!skill.filePath || seen.has(skill.name)) continue;
		seen.add(skill.name);
		out.push(skill);
	}
	return out;
}

export function findSkillByName(skills: SkillLite[], name: string): SkillLite | undefined {
	return skills.find((s) => s.name === name);
}

/** One-liner list for the tool description: `- name: description`. */
export function catalogSummary(skills: SkillLite[]): string {
	return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** Full body handed to agy when it activates a skill. */
export function readSkillBody(skill: SkillLite): string {
	try {
		return fs.readFileSync(skill.filePath, "utf8");
	} catch (err) {
		return `failed to read skill: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** JSON schema for the activate_skill bridge tool. */
export function activateSkillSchema(skills: SkillLite[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			name: {
				type: "string",
				enum: skills.map((s) => s.name),
				description: "Skill name from the catalog in this tool's description.",
			},
		},
		required: ["name"],
	};
}
