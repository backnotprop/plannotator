/**
 * Context notes (approval "inbox-context-notes"): what an agent can send and
 * read. The guide author's notes are checked when the guide is sent (each
 * inside one hunk) and make a version-4 snapshot; every word that tells an
 * agent about notes rides the Code review switch, so with it off the texts are
 * what they were and a notes snapshot is refused. No Inbox is started: the
 * check is called directly and the MCP server is built, never served.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_PATCH_TS_JSON, FIXTURE_V1_LOCAL } from "@plannotator/core/guide-format-fixtures";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { INBOX_GUIDE_FIELD_DESCRIPTION, INBOX_GUIDE_FIELD_DESCRIPTION_WITH_NOTES, INBOX_NOTE_BLOCK_LINE, INBOX_REVIEW_NOTES_RULE } from "@plannotator/core/inbox-review";
import { GUIDE_BRIEF_EXAMPLE_WITH_NOTE, checkInboxGuide } from "./inbox-guides";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-context-notes-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const guide = (notes?: unknown) => ({
  title: "Auth token refresh",
  intent: "Harden the refresh path.",
  sections: [
    { title: "Guard", overview: "Rejects a missing token.", diffs: [{ file: "src/auth.ts", summary: "Adds the guard.", ...(notes !== undefined ? { notes } : {}) }] },
    { title: "Housekeeping", overview: "Version bump.", diffs: [{ file: "package.json", summary: "1.0.1" }] },
  ],
});
const note = { lineStart: 2, lineEnd: 4, text: "Refresh happens here so callers stop retrying." };

describe("submit_guide: the guide author's notes", () => {
  test("Code review on: a note inside one hunk makes a version-4 snapshot that keeps it", () => {
    const checked = checkInboxGuide({ guide: guide([note]), patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.snapshot.version).toBe(4);
    expect(checked.snapshot.guide.sections[0]!.diffs[0]!.notes).toEqual([note]);
  });

  test("the brief's example with a note is a call that works as it is", () => {
    const checked = checkInboxGuide(GUIDE_BRIEF_EXAMPLE_WITH_NOTE, root, { codeReview: true });
    expect(checked.ok && checked.snapshot.version).toBe(4);
  });

  test("a guide with no note stays the version it was", () => {
    const checked = checkInboxGuide({ guide: guide(), patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview: true });
    expect(checked.ok && checked.snapshot.version).toBe(1);
  });

  test("a note outside one hunk is refused, naming the note and its lines", () => {
    const checked = checkInboxGuide({ guide: guide([{ ...note, lineStart: 5, lineEnd: 30 }]), patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview: true });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain("sections[0].diffs[0].notes[0] (src/auth.ts, lines 5–30) is not inside one hunk");
  });

  test("a malformed note is refused in words that name it", () => {
    const checked = checkInboxGuide({ guide: guide([{ lineStart: 2, text: "" }]), patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview: true });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain("sections[0].diffs[0].notes[0].text");
  });

  test("a version-4 snapshot is checked the same way, and refused while Code review is off", () => {
    const { reviewed: _r, ...base } = FIXTURE_V1_LOCAL.guide;
    const withNote = (n: typeof note) => buildGuideSnapshot({
      guide: { ...base, sections: base.sections.map((s, i) => (i === 0 ? { ...s, diffs: s.diffs.map((d) => ({ ...d, notes: [n] })) } : s)) },
      reviewed: [false, false],
      review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", source: FIXTURE_V1_LOCAL.source },
      exportedAt: FIXTURE_V1_LOCAL.exportedAt,
    });
    expect(checkInboxGuide({ snapshot: withNote(note) }, root, { codeReview: true }).ok).toBe(true);
    const outside = checkInboxGuide({ snapshot: withNote({ ...note, lineStart: 9, lineEnd: 12 }) }, root, { codeReview: true });
    expect(outside.ok).toBe(false);
    const off = checkInboxGuide({ snapshot: withNote(note) }, root, { codeReview: false });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toContain("Unsupported snapshot version: 4");
  });

  test("Code review off: an authored guide's notes never reach the snapshot", () => {
    const checked = checkInboxGuide({ guide: guide([note]), patch: FIXTURE_PATCH_TS_JSON }, root, { codeReview: false });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.snapshot.version).toBe(1);
    expect(checked.snapshot.guide.sections.some((s) => s.diffs.some((d) => "notes" in d))).toBe(false);
  });
});

describe("the words that tell an agent about notes ride the Code review switch", () => {
  type Registered = Record<string, { description?: string; inputSchema?: { shape?: Record<string, { description?: string }> }; handler?: (input: unknown, ctx: unknown) => Promise<unknown> }>;
  const tools = (codeReview: boolean): Registered => {
    const server = createInboxMcpServer({ codeReviewOn: () => codeReview } as unknown as InboxMcpContext);
    return (server as unknown as { _registeredTools: Registered })._registeredTools;
  };
  const field = (registered: Registered, tool: string, name: string) => registered[tool]?.inputSchema?.shape?.[name]?.description ?? "";
  const brief = async (codeReview: boolean) => JSON.stringify(await tools(codeReview).get_guide_brief!.handler!({}, {}));

  test("send_message's body names the `:::note` block only while Code review is on", () => {
    expect(field(tools(true), "send_message", "body")).toContain(INBOX_NOTE_BLOCK_LINE);
    expect(field(tools(false), "send_message", "body")).not.toContain(":::note");
  });

  test("submit_guide's guide field names `notes` only while Code review is on", () => {
    expect(field(tools(true), "submit_guide", "guide")).toBe(INBOX_GUIDE_FIELD_DESCRIPTION_WITH_NOTES);
    expect(field(tools(false), "submit_guide", "guide")).toBe(INBOX_GUIDE_FIELD_DESCRIPTION);
    expect(INBOX_GUIDE_FIELD_DESCRIPTION).not.toContain("notes");
  });

  test("get_guide_brief's notes rule, schema and example note only while Code review is on", async () => {
    const on = await brief(true);
    const off = await brief(false);
    expect(on).toContain(JSON.stringify(INBOX_REVIEW_NOTES_RULE).slice(1, 40));
    expect(on).toContain("lineStart");
    expect(off).not.toContain("lineStart");
    expect(off).not.toContain(JSON.stringify(INBOX_REVIEW_NOTES_RULE).slice(1, 40));
  });
});
