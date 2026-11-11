import { describe, expect, test } from "bun:test";
import {
  GUIDE_BUILDER_METHODOLOGY,
  GUIDE_BUILDER_METHODOLOGY_SOURCE_PASSAGES,
  GUIDE_BUILDER_PROMPT_PARAGRAPH,
  GUIDE_BUILDER_RESUME_PARAGRAPH,
  GUIDE_BUILDER_TOOL_NAMES,
  GUIDE_BUILDER_TOOLS,
  buildGuideBuilderPrompt,
} from "./guide-builder-tools";
import { createGuideDraft, runGuideBuilderTool } from "./guide-builder";
import { GUIDE_REVIEW_PROMPT } from "./guide-prompt";

const draft = createGuideDraft({
  review: { rawPatch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", gitRef: "HEAD", source: { kind: "local" } },
  now: "2026-10-22T00:00:00.000Z",
});

describe("tool definitions", () => {
  test("one definition per tool, in the listed order, with an object schema that refuses extra fields", () => {
    expect(GUIDE_BUILDER_TOOLS.map((t) => t.name)).toEqual([...GUIDE_BUILDER_TOOL_NAMES]);
    for (const tool of GUIDE_BUILDER_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeLessThan(2_048);
      for (const key of tool.inputSchema.required ?? []) expect(Object.keys(tool.inputSchema.properties)).toContain(key);
    }
  });

  test("each schema names exactly the arguments the dispatcher takes", async () => {
    for (const tool of GUIDE_BUILDER_TOOLS) {
      const answer = await runGuideBuilderTool(draft, tool.name, { __probe: 1 });
      expect(answer.ok).toBe(false);
      const props = Object.keys(tool.inputSchema.properties);
      const takes = /It takes: (.*)\./.exec(answer.text)?.[1]?.split(", ") ?? [];
      expect(takes.sort()).toEqual(props.sort());
      if ((tool.inputSchema.required ?? []).length > 0) {
        const missing = await runGuideBuilderTool(draft, tool.name, {});
        expect(missing.text).toContain(`${tool.name} needs \`${tool.inputSchema.required![0]}\``);
      }
    }
  });

  test("only guide_read is read-only; only guide_remove_chapter is destructive", () => {
    expect(GUIDE_BUILDER_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["guide_read"]);
    expect(GUIDE_BUILDER_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(["guide_remove_chapter"]);
  });
});

describe("prompt pieces", () => {
  test("every passage the builder methodology rewrites is still in the source prompt", () => {
    for (const passage of GUIDE_BUILDER_METHODOLOGY_SOURCE_PASSAGES) expect(GUIDE_REVIEW_PROMPT).toContain(passage);
  });

  test("the source prompt is untouched: current in-app jobs send the same bytes", () => {
    expect(GUIDE_REVIEW_PROMPT).toContain("## Speed");
    expect(GUIDE_REVIEW_PROMPT).toContain("If one file has two unrelated changes, split it into two sections.");
    expect(GUIDE_REVIEW_PROMPT).toContain("8. Return structured JSON matching the schema.");
  });

  test("the builder methodology speaks of chapters and files placed with the tools", () => {
    const m = GUIDE_BUILDER_METHODOLOGY;
    expect(m).not.toContain("## Speed");
    expect(m).not.toMatch(/\bsections?\b/i);
    expect(m).not.toContain("diffs[]");
    expect(m).not.toMatch(/\bdiffs\b/);
    expect(m).not.toContain("unplacedFiles");
    expect(m).not.toMatch(/JSON|split it into two/);
    expect(m).toContain("A file\nbelongs to exactly one chapter, whole");
    expect(m).toContain("`guide_add_chapter`");
    expect(m).toContain("`guide_place_file`");
    expect(m).toContain("`guide_unplace_file`");
    expect(m).toContain("7. Verify coverage with `guide_read`");
    expect(m).toContain("8. Call `guide_finish`.");
    expect(m).toContain("## Coverage rule (hard constraint)");
  });

  test("buildGuideBuilderPrompt: target, methodology, the tools paragraph, then resume and instructions", () => {
    const prompt = buildGuideBuilderPrompt({ target: "https://github.com/acme/hooks/pull/482", instructions: "  Focus on retries.  ", resume: true });
    expect(prompt.startsWith("Write a guided review of https://github.com/acme/hooks/pull/482.")).toBe(true);
    const order = [GUIDE_BUILDER_METHODOLOGY, GUIDE_BUILDER_PROMPT_PARAGRAPH, GUIDE_BUILDER_RESUME_PARAGRAPH, "## Reviewer instructions\nFocus on retries."].map((p) => prompt.indexOf(p));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const plain = buildGuideBuilderPrompt({ target: "main..HEAD" });
    expect(plain).not.toContain(GUIDE_BUILDER_RESUME_PARAGRAPH);
    expect(plain).not.toContain("Reviewer instructions");
  });
});
