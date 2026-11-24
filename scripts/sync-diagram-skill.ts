// The portable Markdown installed from a release tag and the built-in Inbox skill share one body.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_SKILL } from "../packages/core/diagram-skill";

const skillPath = join(import.meta.dir, "..", "apps", "skills", "core", "diagram", "SKILL.md");

export function diagramSkillMarkdown(): string {
  const { name, description, body } = DIAGRAM_SKILL;
  return `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: true\n---\n\n${body}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    writeFileSync(skillPath, diagramSkillMarkdown());
  } else if (args.length === 1 && args[0] === "--check") {
    if (readFileSync(skillPath, "utf8") !== diagramSkillMarkdown()) {
      console.error("The bundled diagram skill is stale. Run bun run gen:diagram-skill.");
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: bun run gen:diagram-skill [--check]");
    process.exitCode = 1;
  }
}
