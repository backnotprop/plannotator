/**
 * A chapter's diagram (approval "guide-chapter-diagrams": diagrams live in chapters, the overview takes none): what
 * an agent can send and read. A chapter's diagram makes a version-5 snapshot and rides the Code review switch, as
 * the overview's did; an older session's overview diagram is still taken. No Inbox is started: the check is called
 * directly and the MCP server is built, never served.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_PATCH_TS_JSON, FIXTURE_V1_LOCAL } from "@plannotator/core/guide-format-fixtures";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { INBOX_REVIEW_CHAPTER_DIAGRAM_DOC, inboxReviewChapterDiagramDoc } from "@plannotator/core/inbox-review";
import { checkInboxGuide } from "./inbox-guides";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-chapter-diagrams-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mermaid = { kind: "mermaid", source: "flowchart LR\n  a[request] --> b[guard] --> c[refresh]" };
const drawing = (code: string) => ({ kind: "html", source: `<div data-mark="g" data-code="${code}">guard</div>`, width: 800, height: 360 });
const guide = (diagram?: unknown, extra: Record<string, unknown> = {}) => ({
  title: "Auth token refresh",
  intent: "Harden the refresh path.",
  ...extra,
  sections: [
    { title: "Guard", overview: "Rejects a missing token.", ...(diagram !== undefined ? { diagram } : {}), diffs: [{ file: "src/auth.ts", summary: "Adds the guard." }] },
    { title: "Housekeeping", overview: "Version bump.", diffs: [{ file: "package.json", summary: "1.0.1" }] },
  ],
});
const send = (g: unknown, codeReview = true, review = true) => checkInboxGuide({ guide: g, patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview, review });

describe("submit_guide: a chapter's diagram", () => {
  test("Code review on: a Mermaid diagram makes a version-5 snapshot, on its own chapter only", () => {
    const checked = send(guide(mermaid));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.snapshot.version).toBe(5);
    expect(checked.snapshot.guide.sections[0]!.diagram).toEqual(mermaid);
    expect("diagram" in checked.snapshot.guide.sections[1]!).toBe(false);
  });

  test("a guide with no chapter diagram stays the version it was", () => {
    const checked = send(guide());
    expect(checked.ok && checked.snapshot.version).toBe(1);
  });

  test("an html picture is checked by Shape's rules and the patch's files, the refusal naming its chapter", () => {
    const good = send(guide(drawing("src/auth.ts#L2")));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.snapshot.guide.sections[0]!.diagram?.kind).toBe("html");
    const outside = send(guide(drawing("src/other.ts#L1")));
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error).toContain("sections[0].diagram has problems");
      expect(outside.error).toContain("src/other.ts is not a file in this review");
    }
  });

  test("a malformed diagram is refused in words that name its chapter", () => {
    const extra = send(guide({ ...mermaid, css: "x" }));
    expect(!extra.ok && extra.error).toBe("sections[0]: diagram.css: a mermaid diagram is { kind, source }.");
    const empty = send(guide({ kind: "mermaid", source: " " }));
    expect(!empty.ok && empty.error).toBe("sections[0]: diagram.source is empty.");
    const notObject = send(guide("flowchart LR"));
    expect(notObject.ok).toBe(false);
  });

  test("Code review off: a chapter's diagram never reaches the snapshot", () => {
    const checked = send(guide(mermaid), false, false);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.snapshot.version).toBe(1);
    expect(checked.snapshot.guide.sections.some((s) => "diagram" in s)).toBe(false);
  });

  test("an older session's overview diagram is still taken, beside chapter diagrams", () => {
    const overview = { text: "How it fits.", diagram: { kind: "mermaid", source: "flowchart TD\n  x --> y" } };
    const old = send(guide(undefined, { overview }));
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.snapshot.guide.overview).toEqual(overview);
    const both = send(guide(mermaid, { overview }));
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.snapshot.version).toBe(5);
    expect(both.snapshot.guide.overview).toEqual(overview);
    expect(both.snapshot.guide.sections[0]!.diagram).toEqual(mermaid);
  });

  test("a note and a chapter diagram travel together on a review", () => {
    const g = guide(mermaid);
    (g.sections[0]!.diffs[0] as Record<string, unknown>).notes = [{ lineStart: 2, lineEnd: 4, text: "Why the guard is here." }];
    const checked = send(g);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.snapshot.version).toBe(5);
    expect(checked.snapshot.guide.sections[0]!.diffs[0]!.notes).toHaveLength(1);
    expect(checked.snapshot.guide.sections[0]!.diagram).toEqual(mermaid);
  });

  test("a version-5 snapshot is checked the same way, and refused while Code review is off", () => {
    const { reviewed: _r, ...base } = FIXTURE_V1_LOCAL.guide;
    const withDiagram = (diagram: unknown) =>
      buildGuideSnapshot({
        guide: { ...base, sections: base.sections.map((s, i) => (i === 0 ? { ...s, diagram } : s)) } as typeof base,
        reviewed: [false, false],
        review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", source: FIXTURE_V1_LOCAL.source },
        exportedAt: FIXTURE_V1_LOCAL.exportedAt,
      });
    const on = checkInboxGuide({ snapshot: withDiagram(mermaid) }, root, { codeReview: true });
    expect(on.ok && on.snapshot.version).toBe(5);
    const bad = checkInboxGuide({ snapshot: withDiagram(drawing("src/other.ts#L1")) }, root, { codeReview: true });
    expect(!bad.ok && bad.error).toContain("sections[0].diagram has problems");
    const off = checkInboxGuide({ snapshot: withDiagram(mermaid) }, root, { codeReview: false });
    expect(!off.ok && off.error).toContain("Unsupported snapshot version: 5");
  });
});

describe("get_guide_brief offers a chapter's diagram, not the overview's", () => {
  type Registered = Record<string, { handler?: (input: unknown, ctx: unknown) => Promise<unknown> }>;
  const brief = async (codeReview: boolean, shape = true) => {
    const server = createInboxMcpServer({ codeReviewOn: () => codeReview, shapeOn: () => shape } as unknown as InboxMcpContext);
    const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
    return ((await tools.get_guide_brief!.handler!({}, {})) as { structuredContent: { output_schema: Record<string, any>; rules: string[] } }).structuredContent;
  };

  test("Code review on: the schema has sections[].diagram and an overview of text only; the rules say when to draw", async () => {
    const { output_schema: schema, rules } = await brief(true);
    expect(schema.properties.sections.items.properties.diagram.properties.kind.enum).toEqual(["mermaid", "html"]);
    expect(schema.properties.overview.properties).toEqual({ text: { type: "string" } });
    expect(rules).toContain(INBOX_REVIEW_CHAPTER_DIAGRAM_DOC);
    expect(rules.join("\n")).not.toContain("overview.diagram");
  });

  test("Code review off: no diagram anywhere in the brief's schema or rules", async () => {
    const { output_schema: schema, rules } = await brief(false);
    expect(JSON.stringify(schema)).not.toContain("diagram");
    expect(rules.join("\n")).not.toContain("diagram");
  });

  test("Code review on and Shape off (#2974): the schema's chapter diagram is Mermaid only and no rule names Shape", async () => {
    const { output_schema: schema, rules } = await brief(true, false);
    expect(schema.properties.sections.items.properties.diagram.properties).toEqual({ kind: { enum: ["mermaid"] }, source: { type: "string" } });
    expect(schema.properties.overview.properties).toEqual({ text: { type: "string" } });
    expect(rules).toContain(inboxReviewChapterDiagramDoc(false));
    const all = JSON.stringify({ schema, rules });
    for (const word of ["html", "plannotator shape", "Shape", "\"css\"", "\"tall\""]) expect([word, all.includes(word)]).toEqual([word, false]);
    // Shape's switch absent from the context: off.
    const server = createInboxMcpServer({ codeReviewOn: () => true } as unknown as InboxMcpContext);
    const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
    const absent = ((await tools.get_guide_brief!.handler!({}, {})) as { structuredContent: { rules: string[] } }).structuredContent;
    expect(absent.rules).toContain(inboxReviewChapterDiagramDoc(false));
  });

  test("with Shape off the rule offers Mermaid only: no html kind, no Shape rules", () => {
    const off = inboxReviewChapterDiagramDoc(false);
    expect(off).toContain('{ "kind": "mermaid", "source" }');
    expect(off).not.toContain("html");
    expect(off).not.toContain("plannotator shape --help");
    expect(inboxReviewChapterDiagramDoc(true)).toContain("plannotator shape --help");
  });
});
