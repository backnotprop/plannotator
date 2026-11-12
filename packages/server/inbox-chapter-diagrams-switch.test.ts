import { describe, expect, test } from "bun:test";
import { INBOX_REVIEW_CURATE_DRAWING_LINE, INBOX_REVIEW_CURATE_DRAWING_LINE_NO_SHAPE, INBOX_REVIEW_RECHECK_DRAWING_LINE, inboxReviewSkills } from "@plannotator/core/inbox-review";
import { registerInboxGuideTools } from "./inbox-guides";
import type { InboxMcpContext } from "./inbox-mcp";

interface Texts {
  brief: { methodology: string; output_schema: { properties: { sections: { items: { properties: Record<string, unknown> } } } }; rules: string[]; example: unknown; diff_steps: unknown };
  guideField: string;
  skills: string[];
}

async function texts(shape: boolean, diagrams?: boolean): Promise<Texts> {
  const tools: Record<string, { config: { inputSchema: { shape: { guide: { description?: string } } } }; handler: (input: unknown, ctx: unknown) => Promise<{ structuredContent: Texts["brief"] }> }> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) };
  const context = { codeReviewOn: () => true, shapeOn: () => shape, ...(diagrams === undefined ? {} : { chapterDiagramsOn: () => diagrams }) } as unknown as InboxMcpContext;
  registerInboxGuideTools(server as never, context);
  const brief = (await tools.get_guide_brief!.handler({}, {})).structuredContent;
  return {
    brief,
    guideField: tools.submit_guide!.config.inputSchema.shape.guide.description ?? "",
    skills: inboxReviewSkills(diagrams === undefined ? { shape } : { shape, diagrams }).map((skill) => skill.body),
  };
}

describe("Chapter diagrams' switch", () => {
  for (const shape of [false, true]) {
    test(`on is byte for byte the text with no switch (Shape ${shape ? "on" : "off"})`, async () => {
      expect(JSON.stringify(await texts(shape, true))).toBe(JSON.stringify(await texts(shape)));
    });

    test(`off names no chapter diagram anywhere (Shape ${shape ? "on" : "off"})`, async () => {
      const off = await texts(shape, false);
      const all = JSON.stringify(off);
      expect([/diagram/i.test(all), /mermaid/i.test(all), all.includes("plannotator shape --help")]).toEqual([false, false, false]);
      expect(off.brief.rules.length).toBeGreaterThan(1);
      expect(off.skills.length).toBe(3);
    });

    test(`off only removes: the rule, the schema's key, "diagram?" and the two skill lines (Shape ${shape ? "on" : "off"})`, async () => {
      const on = await texts(shape, true);
      const off = await texts(shape, false);
      expect(on.brief.rules.filter((rule) => !rule.includes("sections[].diagram"))).toEqual(off.brief.rules);
      expect(on.brief.rules.length - off.brief.rules.length).toBe(1);
      const schema = structuredClone(on.brief.output_schema);
      delete schema.properties.sections.items.properties.diagram;
      expect(off.brief.output_schema).toEqual(schema);
      expect({ ...on.brief, rules: null, output_schema: null }).toEqual({ ...off.brief, rules: null, output_schema: null });
      expect(on.guideField.replace("diagram?, ", "")).toBe(off.guideField);
      expect(on.guideField).not.toBe(off.guideField);
      const curate = shape ? INBOX_REVIEW_CURATE_DRAWING_LINE : INBOX_REVIEW_CURATE_DRAWING_LINE_NO_SHAPE;
      expect(on.skills.map((body) => body.replace(`\n\n${curate}`, "").replace(`${INBOX_REVIEW_RECHECK_DRAWING_LINE}\n\n`, ""))).toEqual(off.skills);
      expect(on.skills).not.toEqual(off.skills);
    });
  }
});
