import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagramSkillMarkdown } from "../../scripts/sync-diagram-skill";
import type { ReferenceSkill } from "./review-skill-loader";
import { inboxSkillCatalog, inboxSkillsBlockFor } from "./inbox-skills";

test("Inbox offers diagram authoring on a fresh install and sends the bundled instructions", async () => {
  const sources = { discovered: () => [], read: () => null };
  const { skills } = await inboxSkillCatalog({}, sources.discovered).json();
  expect(skills.filter((skill: ReferenceSkill) => skill.name === "diagram")).toMatchObject([
    { root: "plannotator", humanOnly: true },
  ]);
  const switches = { codeReview: false, routines: false, diagrams: false };
  const message = inboxSkillsBlockFor(["diagram"], switches, sources);
  expect(message).toContain("BEGIN SKILL INSTRUCTIONS: diagram");
  expect(message).toContain("plannotator diagram render");
});

test("Inbox lists one diagram skill and gives a person's own copy precedence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diagram-skill-"));
  const skill: ReferenceSkill = { name: "diagram", root: "universal", dir, humanOnly: false };
  async function entries() {
    const response = await inboxSkillCatalog({}, () => [skill]).json();
    return response.skills.filter((row: ReferenceSkill) => row.name === "diagram");
  }
  try {
    expect(await entries()).toEqual([skill]);
    writeFileSync(join(dir, ".plannotator-installed"), "");
    expect(await entries()).toMatchObject([{ name: "diagram", root: "plannotator", humanOnly: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Markdown skill sent to agents is the one Inbox embeds", () => {
  const file = join(import.meta.dir, "..", "..", "apps", "skills", "core", "diagram", "SKILL.md");
  expect(readFileSync(file, "utf8")).toBe(diagramSkillMarkdown());
});
