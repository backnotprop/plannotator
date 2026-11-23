import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagramSkillMarkdown } from "../../scripts/gen-skill-sections";
import type { ReferenceSkill } from "./review-skill-loader";
import { inboxSkillCatalog, inboxSkillsBlockFor } from "./inbox-skills";

test("the diagram capability supplies authoring instructions when no agent skill is installed", () => {
  const switches = { codeReview: false, shape: false, routines: false, diagrams: false };
  const sources = { discovered: () => [], read: () => null };
  expect(inboxSkillsBlockFor(["diagram"], switches, sources)).toBe("");
  const message = inboxSkillsBlockFor(["diagram"], { ...switches, diagramArtifacts: true }, sources);
  expect(message).toContain("BEGIN SKILL INSTRUCTIONS: diagram");
  expect(message).toContain("plannotator diagram render");
});

test("the installed Plannotator copy obeys the Inbox switch, and another author's skill wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diagram-skill-"));
  const skill: ReferenceSkill = { name: "diagram", root: "universal", dir, humanOnly: false };
  async function entries(on: boolean) {
    const response = await inboxSkillCatalog(false, () => [skill], false, false, on).json();
    return response.skills.filter((row: ReferenceSkill) => row.name === "diagram");
  }
  try {
    expect(await entries(true)).toEqual([skill]);
    writeFileSync(join(dir, ".plannotator-installed"), "");
    expect(await entries(false)).toEqual([]);
    expect(await entries(true)).toMatchObject([{ name: "diagram", root: "plannotator", humanOnly: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Markdown skill sent to agents is the one Inbox embeds", () => {
  const file = join(import.meta.dir, "..", "..", "apps", "skills", "core", "diagram", "SKILL.md");
  expect(readFileSync(file, "utf8")).toBe(diagramSkillMarkdown());
});
