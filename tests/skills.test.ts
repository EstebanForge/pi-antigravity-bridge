// Skills discovery tests: pin scanSkills to pi's documented locations and
// per-location rules (pi docs/skills.md "Locations"). Real home is never
// touched: both projectDir and home are injected tmp dirs.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills, skillLocations } from "../src/skills.js";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-"));
}

const SKILL_MD = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function writeDirSkill(root: string, rel: string, name = path.basename(rel), description = `${name} does things`): void {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD(name, description));
}

function writeMdSkill(root: string, file: string, name: string, description = `${name} does things`): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), SKILL_MD(name, description));
}

test("skills: global ~/.agents/skills grouping folders are discovered recursively", () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".agents", "skills"), "work/deployskill");
	const names = scanSkills(undefined, home).map((s) => s.name);
	assert.ok(names.includes("deployskill"));
});

test("skills: agents-style ignores root .md, discovers grouping-folder .md with frontmatter", () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	writeMdSkill(root, "loose.md", "loose-skill"); // root .md: ignored
	writeMdSkill(root, "work/notes.md", "notes"); // nested .md: discovered
	fs.mkdirSync(path.join(root, "work"), { recursive: true });
	fs.writeFileSync(path.join(root, "work", "nofrontmatter.md"), "# just prose\n"); // no frontmatter: ignored
	const names = scanSkills(undefined, home).map((s) => s.name);
	assert.ok(!names.includes("loose-skill"));
	assert.ok(names.includes("notes"));
	assert.ok(!names.includes("nofrontmatter"));
});

test("skills: pi-style root .md files are individual skills", () => {
	const home = tmp();
	writeMdSkill(path.join(home, ".pi", "agent", "skills"), "quick-note.md", "quick-note");
	assert.ok(scanSkills(undefined, home).some((s) => s.name === "quick-note"));
});

test("skills: entries without a description are not loaded", () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "undescribed"), { recursive: true });
	fs.writeFileSync(path.join(root, "undescribed", "SKILL.md"), "---\nname: undescribed\n---\nbody\n");
	writeMdSkill(root, "group/blank.md", "blank", "");
	const names = scanSkills(undefined, home).map((s) => s.name);
	assert.ok(!names.includes("undescribed"));
	assert.ok(!names.includes("blank"));
});

test("skills: a skill dir is self-contained, no descent past SKILL.md", () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	writeDirSkill(root, "outer");
	writeDirSkill(path.join(root, "outer"), "inner");
	assert.ok(!scanSkills(undefined, home).some((s) => s.name === "inner"));
});

test("skills: project .pi/skills, project .agents/skills, and the git-root ancestor walk", () => {
	const container = tmp();
	const repo = path.join(container, "repo");
	const project = path.join(repo, "services", "app");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	writeMdSkill(path.join(container, ".agents", "skills"), "above-repo.md", "above-repo"); // outside the walk
	writeDirSkill(path.join(repo, ".agents", "skills"), "repo-skill");
	writeDirSkill(path.join(project, ".agents", "skills"), "local-skill");
	writeMdSkill(path.join(project, ".pi", "skills"), "inline.md", "inline");

	const found = scanSkills(project, container);
	const names = found.map((s) => s.name);
	assert.ok(names.includes("repo-skill"), "git-root ancestor discovered");
	assert.ok(names.includes("local-skill"), "project .agents/skills discovered");
	assert.ok(names.includes("inline"), "project .pi/skills root .md discovered");
	assert.ok(!names.includes("above-repo"), "walk stops at the git root");
});

test("skills: name collisions keep the first location (pi dir before agents dir)", () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".pi", "agent", "skills"), "dup", "dup", "from pi dir");
	writeDirSkill(path.join(home, ".agents", "skills"), "dup", "dup", "from agents dir");
	const dup = scanSkills(undefined, home).find((s) => s.name === "dup");
	assert.equal(dup?.description, "from pi dir");
});

test("skills: a UTF-8 BOM does not break frontmatter detection", () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "bommed"), { recursive: true });
	fs.writeFileSync(path.join(root, "bommed", "SKILL.md"), `\uFEFF${SKILL_MD("bommed", "survives the BOM")}`);
	assert.ok(scanSkills(undefined, home).some((s) => s.name === "bommed"));
});

test("skills: hidden entries are skipped", () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".agents", "skills"), ".system/skill-creator");
	assert.ok(!scanSkills(undefined, home).some((s) => s.name === "skill-creator"));
});

test("skills: location order is pi global, agents global, then project dirs", () => {
	const home = tmp();
	const repo = path.join(tmp(), "repo");
	const project = path.join(repo, "proj");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const locs = skillLocations(project, home).map((l) => l.dir);
	assert.deepEqual(locs, [
		path.join(home, ".pi", "agent", "skills"),
		path.join(home, ".agents", "skills"),
		path.join(project, ".pi", "skills"),
		path.join(project, ".agents", "skills"),
		path.join(repo, ".agents", "skills"),
	]);
});
