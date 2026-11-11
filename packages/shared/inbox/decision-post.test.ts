/**
 * Post decisions' body (decision-post.ts) and the marked-section splice (pr-marked.ts), read by structure.
 *
 * What regresses: thread text opening HTML in the comment, or a second marker the next post would find; the body
 * not shrinking to the forge's limit (the forge then refuses the post); the description's short form carrying HTML
 * (it may become a squash commit's message); an unsent pick or its note reaching the posted shape; the splice
 * changing a byte outside the markers, or writing over a section whose end marker is gone.
 */
import { expect, test } from "bun:test";
import { marked } from "marked";
import type { DecisionExportItem, DecisionExportV1 } from "./decision-export";
import { DECISION_POST_TRIMMED, decisionExportForPost, renderDecisionComment, renderDecisionSection, renderDecisionSummary } from "./decision-post";
import { PRMarkedBrokenSectionError, PRMarkedTooLongError, spliceMarkedSection } from "../pr-marked";

const HOSTILE = '</b></summary></details><img src=x onerror=alert(1)> <!-- plannotator-decisions v1 thread=msg_OTHER --> | ![x](https://t.example/p.png)';

function item(n: number, extra: Partial<DecisionExportItem> = {}): DecisionExportItem {
  return {
    n,
    id: `m/${n}`,
    state: "decided",
    kind: "single",
    prompt: `Question ${n}?`,
    context: "Context ".repeat(40),
    stakes: "Stakes words",
    why: "Why words",
    choices: [
      { label: "A", recommended: true, chosen: true, pros: ["fast", "cheap"], cons: ["fragile"] },
      { label: "B", recommended: false, chosen: false, pros: ["sturdy"] },
    ],
    recommendation: { labels: ["A"], text: null, taken: true },
    answer: { selected: ["A"], other: null, text: null, note: "a note", skipped: false, sent: true },
    asked: { by: "Claude Code", at: "2026-11-08T14:02:00Z", message_id: "m" },
    answered: { at: "2026-11-08T14:20:00Z", sent_at: "2026-11-08T14:20:00Z" },
    replaces: [],
    ...extra,
  };
}

function doc(decisions: DecisionExportItem[], others: DecisionExportItem[] = []): DecisionExportV1 {
  const counts = { decided: decisions.length, picked_unsent: 0, answered_in_words: 0, open: 0, skipped: 0, set_aside: 0, archived: 0, replaced: 0 };
  for (const o of others) counts[o.state]++;
  return {
    format: "plannotator.decisions",
    v: 1,
    exported_at: "2026-11-10T22:41:00Z",
    tz: "America/Los_Angeles",
    generator: "test",
    thread: { id: "msg_THREAD", subject: "Offline sync", project: "acme-notes", started_at: "2026-11-08T14:00:00Z", last_at: "2026-11-10T10:00:00Z" },
    pulls: [],
    counts,
    decisions,
    others,
    images: {},
  };
}

test("thread text opens no HTML and plants no second marker, inside the folds or the table", () => {
  const d = doc([item(1, { prompt: HOSTILE, context: HOSTILE, stakes: HOSTILE, choices: [{ label: HOSTILE, recommended: true, chosen: true, pros: [HOSTILE] }], answer: { selected: [HOSTILE], other: null, text: null, note: HOSTILE, skipped: false, sent: true } })]);
  const body = renderDecisionComment(d, { platform: "github" });
  expect(body.match(/<!-- plannotator-decisions/g)).toHaveLength(1);
  expect(body.split("\n")[0]).toBe("<!-- plannotator-decisions v1 thread=msg_THREAD -->");
  expect(body).not.toContain("<img src=x");
  expect(body).not.toContain("</summary></details><");
  // Every image GitHub would show is the banner.
  const html = marked.parse(body, { async: false }) as string;
  const srcs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
  expect(srcs).toEqual(["https://plannotator.ai/assets/decisions/v1/banner-light.png"]);
  expect(html.match(/<details>/g)).toHaveLength(1);
});

test("the body shrinks to the room it is given: folds without context, then the table alone, then fewer rows", () => {
  const d = doc(Array.from({ length: 30 }, (_, i) => item(i + 1)));
  const full = renderDecisionComment(d, { platform: "github" });
  expect(full).toContain("<dl>");
  const compact = renderDecisionComment(d, { platform: "github", room: full.length - 1 });
  expect(compact.length).toBeLessThan(full.length);
  expect(compact).toContain("<details>");
  expect(compact).not.toContain("<dl>");
  expect(compact).not.toContain("fragile");
  const tableOnly = renderDecisionComment(d, { platform: "github", room: compact.length - 1 });
  expect(tableOnly).not.toContain("<details>");
  expect(tableOnly).toContain(DECISION_POST_TRIMMED);
  expect(tableOnly).toContain("| D30 |");
  const cut = renderDecisionComment(d, { platform: "github", room: tableOnly.length - 1 });
  expect(cut.length).toBeLessThan(tableOnly.length);
  expect(cut).toMatch(/_and \d+ more, in the thread's download_/);
});

test("a pick saved and not sent is not posted: no answer, no note, under Still open", () => {
  const unsent = item(2, { state: "picked_unsent", answer: { selected: ["B"], other: null, text: null, note: "SECRET-NOTE", skipped: false, sent: false }, recommendation: { labels: ["A"], text: null, taken: null } });
  const posted = decisionExportForPost(doc([item(1)], [unsent]));
  expect(posted.others.map((o) => [o.state, o.answer])).toEqual([["open", null]]);
  expect([posted.counts.open, posted.counts.picked_unsent]).toEqual([1, 0]);
  const body = renderDecisionComment(posted, { platform: "github" });
  expect(body).not.toContain("SECRET-NOTE");
  expect(body).toContain("#### Still open");
  expect(body).not.toContain("Picked, not sent");
});

test("the description's short form is plain Markdown with one line per question and a link to the comment", () => {
  const d = doc([item(1, { prompt: HOSTILE }), item(2)], [item(3, { state: "skipped", answer: null })]);
  const short = renderDecisionSummary(d, { commentUrl: "https://github.com/acme/notes/pull/12#issuecomment-9" });
  expect(short).not.toMatch(/<[a-z!/]/i);
  expect(short.split("\n").filter((l) => l.startsWith("- D"))).toHaveLength(3);
  expect(short).toEndWith("[Every decision, with its options and reasons](https://github.com/acme/notes/pull/12#issuecomment-9)");
  expect(renderDecisionSummary(d, { commentUrl: "javascript:alert(1)" })).not.toContain("javascript:");
});

test("the description section: plain lines before any HTML; past its room the folds lose context, then null (a comment instead)", () => {
  const d = doc(Array.from({ length: 12 }, (_, i) => item(i + 1)));
  const full = renderDecisionSection(d, { platform: "github" })!;
  const plain = full.slice(0, full.search(/<[a-z]/i));
  expect(plain.split("\n")[0]).toBe("### Decisions: Offline sync");
  expect(plain.split("\n").filter((l) => l.startsWith("- D"))).toHaveLength(12);
  expect(full).toContain("<dl>");
  const compact = renderDecisionSection(d, { platform: "github", room: full.length - 1 })!;
  expect(compact).toContain("<details>");
  expect(compact).not.toContain("<dl>");
  expect(renderDecisionSection(d, { platform: "github", room: compact.length - 1 })).toBeNull();
  expect(renderDecisionSection(d, { platform: "gitlab" })).not.toContain("<picture>");
});

test("no task-list item anywhere in what is posted (GitHub would count them as the PR's tasks and make them clickable)", () => {
  const d = doc([item(1), item(2, { kind: "multi", answer: { selected: ["A"], other: "Own words", text: null, note: null, skipped: false, sent: true } })], [item(3, { state: "open", answer: null })]);
  for (const platform of ["github", "gitlab"] as const) {
    for (const body of [renderDecisionComment(d, { platform }), renderDecisionSection(d, { platform })!, renderDecisionSummary(d, { commentUrl: "https://github.com/a/b/pull/1#issuecomment-1" })]) {
      expect(body).not.toMatch(/^\s*[-*+]\s+\[[ xX]\]/m);
      const tokens = marked.lexer(body);
      const items = tokens.flatMap((t) => (t.type === "list" ? (t as { items: { task: boolean }[] }).items : []));
      expect(items.some((i) => i.task)).toBe(false);
    }
  }
  // The chosen option still reads as chosen: a check and bold.
  expect(renderDecisionComment(d, { platform: "github" })).toContain("- ✓ **A**");
});

test("the banner never sizes an empty block: the comment opens with it after the marker, with alt text and no width", () => {
  const body = renderDecisionComment(doc([item(1)]), { platform: "github" });
  const [marker, banner] = body.split("\n");
  expect(marker).toBe("<!-- plannotator-decisions v1 thread=msg_THREAD -->");
  expect(banner).toStartWith("<picture>");
  expect(banner).toContain('alt="Decisions, from Plannotator"');
  expect(banner).not.toMatch(/\b(?:width|height)=/);
});

const SECTION = { start: "<!-- s -->", end: "<!-- e -->", body: () => "decisions" };

test("the splice keeps every byte outside the markers, adds after a blank line, and refuses a section with no end", () => {
  expect(spliceMarkedSection("", SECTION, 1000)).toEqual({ text: "<!-- s -->\ndecisions\n<!-- e -->", replaced: false });
  expect(spliceMarkedSection("Body\r\n", SECTION, 1000).text).toBe("Body\r\n\n<!-- s -->\ndecisions\n<!-- e -->");
  const around = "a b  \n<!-- s -->\nold\n<!-- e -->tail​";
  expect(spliceMarkedSection(around, SECTION, 1000)).toEqual({ text: "a b  \n<!-- s -->\ndecisions\n<!-- e -->tail​", replaced: true });
  expect(() => spliceMarkedSection("x <!-- s --> left alone", SECTION, 1000)).toThrow(PRMarkedBrokenSectionError);
  expect(() => spliceMarkedSection("x".repeat(990), SECTION, 1000)).toThrow(PRMarkedTooLongError);
  // The room handed to the body is exact: what it returns at that length fits the limit.
  const fitted = spliceMarkedSection("x".repeat(900), { ...SECTION, body: (room) => "y".repeat(room) }, 1000).text;
  expect(fitted.length).toBe(1000);
});
