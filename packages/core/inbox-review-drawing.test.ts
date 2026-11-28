/**
 * The checks a guide's html diagram gets (submit_guide still takes one), by the
 * field names an agent writes (`source`, `tall.source`); the review skills'
 * chapter-diagram lines; and the review's lines and rounds the windows name.
 */
import { describe, expect, test } from "bun:test";
import {
  checkInboxDrawing,
  INBOX_REVIEW_SKILL_TEXTS,
  INBOX_REVIEW_CURATE_DRAWING_LINE,
  INBOX_REVIEW_RECHECK_DRAWING_LINE,
  inboxDrawingCodes,
  inboxReviewLines,
  inboxReviewRound,
  inboxReviewSkill,
  inboxReviewSkills,
} from "./inbox-review";

describe("checkInboxDrawing", () => {
  const files = ["src/jobs/retry-worker.ts", "src/email/dunning.ts"];
  const ok = { kind: "html", title: "After the third failure", source: '<div data-mark="fails" data-code="src/jobs/retry-worker.ts#L11">fails</div>', width: 800, height: 360, tall: { source: "<div>fails</div>" } };

  test("a good drawing becomes a drawn view in the drawing's own fields", () => {
    const checked = checkInboxDrawing(ok, files);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.title).toBe("After the third failure");
      expect(checked.view).toEqual({ html: ok.source, width: 800, height: 360, tall: { html: ok.tall.source } });
    }
  });

  test("problems name the agent's own fields", () => {
    const checked = checkInboxDrawing({ ...ok, kind: "svg", width: 100, source: "<script>x</script>", tall: { source: '<img src="https://x">' }, extra: 1 }, files);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      const all = checked.problems.join("\n");
      expect(all).toContain("extra: is not a field");
      expect(all).toContain('kind: must be "html"');
      expect(checked.problems.some((p) => p.startsWith("source"))).toBe(true);
      expect(checked.problems.some((p) => p.startsWith("tall.source"))).toBe(true);
      expect(checked.problems.some((p) => p.startsWith("width"))).toBe(true);
      expect(all).not.toContain("@");
      expect(all).not.toMatch(/\bhtml\b:/);
    }
  });

  test("a part's code must be a file of the review", () => {
    const checked = checkInboxDrawing({ ...ok, source: '<div data-code="src/other.ts#L1">x</div>' }, files);
    expect(!checked.ok && checked.problems).toEqual(['data-code="src/other.ts#L1": src/other.ts is not a file in this review']);
  });

  test("a code the board would draw is checked wherever it is written: the delta-4 review's payloads", () => {
    for (const source of [
      // noscript: the sanitizer parses with scripting off, so this div is markup and stays.
      '<noscript><div data-mark="a" data-code="src/zzz.ts#L1">part</div></noscript>',
      // An end tag the browser ignores inside foreignObject's HTML, then a text element or CDATA.
      '<svg><foreignObject><div></svg></div></foreignObject><textarea><b data-code="src/zzz.ts#L1">x</b></textarea></svg>',
      '<svg><foreignObject><div></svg></div></foreignObject><xmp><b data-code="src/zzz.ts#L1">x</b></xmp></svg>',
      '<svg><foreignObject><span></svg></span></foreignObject><noframes><b data-code="src/zzz.ts#L1">x</b></noframes></svg>',
      '<svg><foreignObject><div></foreignObject><![CDATA[x><b data-code="src/zzz.ts#L1">x</b>]]></div></foreignObject></svg>',
      '<math><annotation-xml><svg><foreignObject><section><![CDATA[x><b data-code="src/zzz.ts#L1">x</b>]]></section></foreignObject></svg></annotation-xml></math>',
      // The delta-3 ones: odd comment ends, `<!--` in a text element, a tag inside another's attribute.
      '<!--><div data-mark="a" data-code="src/zzz.ts#L1">x</div>',
      '<textarea><a title="</textarea><div data-code=src/zzz.ts#L1>">',
    ]) {
      const checked = checkInboxDrawing({ ...ok, source }, files);
      expect([source, !checked.ok && checked.problems]).toEqual([source, ['data-code="src/zzz.ts#L1": src/zzz.ts is not a file in this review']]);
    }
    const unreadable = checkInboxDrawing({ ...ok, source: '<noscript><div data-code="not a target">x</div></noscript>' }, files);
    expect(!unreadable.ok && unreadable.problems).toContain('source: data-code="not a target" is not a file and line in the project (write path#L42)');
  });

  test("the guide's diagram takes no title", () => {
    const checked = checkInboxDrawing(ok, files, { withTitle: false });
    expect(!checked.ok && checked.problems[0]).toStartWith("title: is not a field");
  });

  test("a drawing's codes are listed once each", () => {
    const view = { html: '<i data-code="a.ts#L1"></i><i data-code="b.ts#L2-L4"></i>', tall: { html: '<i data-code="a.ts#L1"></i>' } };
    expect(inboxDrawingCodes(view)).toEqual(["a.ts#L1", "b.ts#L2-L4"]);
  });
});

describe("the review skills offer a chapter's diagram, in Mermaid, with no word of Shape", () => {
  test("/review-curate ends with the chapter line; /review-recheck has its line after its chapters paragraph", () => {
    const curate = inboxReviewSkill("review-curate")!.body;
    expect(curate).toBe(INBOX_REVIEW_SKILL_TEXTS["review-curate"]!.body);
    expect(curate.trimEnd()).toEndWith(INBOX_REVIEW_CURATE_DRAWING_LINE);
    expect(INBOX_REVIEW_CURATE_DRAWING_LINE).toContain("one Mermaid diagram");
    const recheck = inboxReviewSkill("review-recheck")!.body;
    const chapters = recheck.indexOf("Give one chapter to each comment you acted on");
    expect(chapters).toBeGreaterThan(-1);
    expect(recheck.indexOf(INBOX_REVIEW_RECHECK_DRAWING_LINE)).toBeGreaterThan(chapters);
  });

  test("no skill names Shape, a drawing or html", () => {
    expect(inboxReviewSkills().map((skill) => skill.name)).toEqual(["review-curate", "review-walkthrough", "review-recheck"]);
    for (const name of Object.keys(INBOX_REVIEW_SKILL_TEXTS)) {
      const body = INBOX_REVIEW_SKILL_TEXTS[name]!.body;
      for (const word of ["overview.diagram", "drawing", "Shape", "shape --help", "data-mark", "html", "preferred"]) expect([name, body.includes(word)]).toEqual([name, false]);
    }
  });
});

describe("a review's lines and rounds", () => {
  test("lines and rounds", () => {
    expect(inboxReviewLines([16, 18])).toBe("16–18");
    expect(inboxReviewLines([4, 4])).toBe("4");
    const messages = [{ id: "a", guide: { review: true as const } }, { id: "b" }, { id: "c", guide: { review: true as const } }];
    expect(inboxReviewRound(messages, "a")).toBe(1);
    expect(inboxReviewRound(messages, "c")).toBe(2);
  });
});
