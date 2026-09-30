import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_SKILL_NAME, bundledSkillPaths } from "./bundled-skill.ts";

// #1642: the CLI installer writes ~/.agents/skills/plannotator, which Pi loads
// ahead of package skills. The extension must not offer its copy then, or Pi
// prints "[Skill conflicts] "plannotator" collision" on every start.

let root: string;
let bundled: string;
let agentsCopy: string;

function writeSkill(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, `---\nname: ${BUNDLED_SKILL_NAME}\ndescription: test\n---\n`);
	return file;
}

const skillCommand = (path: string) => ({
	name: `skill:${BUNDLED_SKILL_NAME}`,
	source: "skill",
	sourceInfo: { path },
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plannotator-bundled-skill-"));
	bundled = writeSkill(join(root, "pkg", "skills", BUNDLED_SKILL_NAME));
	agentsCopy = writeSkill(join(root, "home", ".agents", "skills", BUNDLED_SKILL_NAME));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("bundledSkillPaths", () => {
	test("extension-only install: offers the bundled skill", () => {
		expect(bundledSkillPaths([], bundled)).toEqual([bundled]);
	});

	test("CLI + extension install: yields to the installer's copy", () => {
		expect(bundledSkillPaths([skillCommand(agentsCopy)], bundled)).toEqual([]);
	});

	test("keeps offering it when the loaded copy is the bundled file itself (reload)", () => {
		expect(bundledSkillPaths([skillCommand(bundled)], bundled)).toEqual([bundled]);
		// Pi dedupes by realpath, so a symlinked path to the same file is ours too.
		const link = join(root, "link.md");
		symlinkSync(bundled, link);
		expect(bundledSkillPaths([skillCommand(link)], bundled)).toEqual([bundled]);
	});

	test("only a skill of the same name counts", () => {
		const commands = [
			{ name: "skill:plannotator-review", source: "skill", sourceInfo: { path: agentsCopy } },
			{ name: `skill:${BUNDLED_SKILL_NAME}`, source: "prompt", sourceInfo: { path: agentsCopy } },
			{ name: BUNDLED_SKILL_NAME, source: "extension", sourceInfo: { path: agentsCopy } },
		];
		expect(bundledSkillPaths(commands, bundled)).toEqual([bundled]);
	});

	test("offers nothing when the vendored copy is missing", () => {
		expect(bundledSkillPaths([], join(root, "missing", "SKILL.md"))).toEqual([]);
	});

	test("the name it yields on is the single-sourced skill's frontmatter name", () => {
		// If the core skill is ever renamed, the extension would stop recognizing
		// the installer's copy and the collision would come back.
		const source = readFileSync(
			join(import.meta.dir, "..", "skills", "core", "plannotator", "SKILL.md"),
			"utf-8",
		);
		expect(source).toMatch(new RegExp(`^---\\nname: ${BUNDLED_SKILL_NAME}\\n`));
	});
});
