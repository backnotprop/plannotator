/**
 * Settings → Capabilities → Chapter diagrams (under Code review, on unless turned off) decides which words an agent
 * reads about a chapter's diagram.
 * What regresses:
 *
 *  - off: a chapter diagram's word left in get_guide_brief (its rule, its schema), in submit_guide's `guide` field or
 *    in the review skills;
 *  - off: anything other than those removals (a word changed or added in their place);
 *  - on: any change at all from a context that names no switch (the Inbox before the switch, and every other caller).
 *
 * The tools are read from `registerInboxGuideTools` itself, through a stand-in for the MCP server: no Inbox starts.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVIEW_CURATE_DRAWING_LINE, INBOX_REVIEW_RECHECK_DRAWING_LINE, inboxReviewSkills } from "@plannotator/core/inbox-review";
import { registerInboxGuideTools } from "./inbox-guides";
import type { InboxMcpContext } from "./inbox-mcp";

interface Texts {
  brief: { methodology: string; output_schema: { properties: { sections: { items: { properties: Record<string, unknown> } } } }; rules: string[]; example: unknown; diff_steps: unknown };
  guideField: string;
  skills: string[];
}

/** get_guide_brief's answer, submit_guide's `guide` field and the review skills' bodies, as an agent reads them. */
async function texts(diagrams?: boolean): Promise<Texts> {
  const tools: Record<string, { config: { inputSchema: { shape: { guide: { description?: string } } } }; handler: (input: unknown, ctx: unknown) => Promise<{ structuredContent: Texts["brief"] }> }> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) };
  const context = { codeReviewOn: () => true, ...(diagrams === undefined ? {} : { chapterDiagramsOn: () => diagrams }) } as unknown as InboxMcpContext;
  registerInboxGuideTools(server as never, context);
  const brief = (await tools.get_guide_brief!.handler({}, {})).structuredContent;
  return {
    brief,
    guideField: tools.submit_guide!.config.inputSchema.shape.guide.description ?? "",
    skills: inboxReviewSkills(diagrams === undefined ? {} : { diagrams }).map((skill) => skill.body),
  };
}

describe("Chapter diagrams' switch", () => {
  {
    test("on is byte for byte the text with no switch", async () => {
      expect(JSON.stringify(await texts(true))).toBe(JSON.stringify(await texts()));
    });

    test("off names no chapter diagram anywhere", async () => {
      const off = await texts(false);
      const all = JSON.stringify(off);
      expect([/diagram/i.test(all), /mermaid/i.test(all), all.includes("plannotator shape --help")]).toEqual([false, false, false]);
      // Not an empty answer: the brief and the skills are all there.
      expect(off.brief.rules.length).toBeGreaterThan(1);
      expect(off.skills.length).toBe(3);
    });

    test("off only removes: the rule, the schema's key, \"diagram?\" and the two skill lines", async () => {
      const on = await texts(true);
      const off = await texts(false);
      // The rule: one entry fewer, the rest in order.
      expect(on.brief.rules.filter((rule) => !rule.includes("sections[].diagram"))).toEqual(off.brief.rules);
      expect(on.brief.rules.length - off.brief.rules.length).toBe(1);
      // The schema: the chapter's `diagram` key gone, nothing else.
      const schema = structuredClone(on.brief.output_schema);
      delete schema.properties.sections.items.properties.diagram;
      expect(off.brief.output_schema).toEqual(schema);
      expect({ ...on.brief, rules: null, output_schema: null }).toEqual({ ...off.brief, rules: null, output_schema: null });
      // submit_guide's field: "diagram?, " gone.
      expect(on.guideField.replace("diagram?, ", "")).toBe(off.guideField);
      expect(on.guideField).not.toBe(off.guideField);
      // The skills: each diagram line with the blank line beside it gone.
      const curate = INBOX_REVIEW_CURATE_DRAWING_LINE;
      expect(on.skills.map((body) => body.replace(`\n\n${curate}`, "").replace(`${INBOX_REVIEW_RECHECK_DRAWING_LINE}\n\n`, ""))).toEqual(off.skills);
      expect(on.skills).not.toEqual(off.skills);
    });
  }
});
