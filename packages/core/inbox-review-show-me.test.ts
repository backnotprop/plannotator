/**
 * Show me's words and checks (approval "shape-in-code-review", ac2). The
 * request is pinned to AGENT-TEXT §1's own example; the drawing check to the
 * field names an agent writes (`source`, `tall.source`), never Shape's.
 */
import { describe, expect, test } from "bun:test";
import {
  checkInboxDrawing,
  INBOX_REVIEW_SKILL_TEXTS,
  INBOX_REVIEW_CURATE_DRAWING_LINE,
  INBOX_REVIEW_RECHECK_DRAWING_LINE,
  inboxDrawingCodes,
  inboxDrawnViewOf,
  inboxReviewLines,
  inboxReviewRound,
  inboxShowMeRequest,
  type InboxShowMeTarget,
} from "./inbox-review";

const target: InboxShowMeTarget = { review: "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F", file: "src/jobs/retry-worker.ts", lines: [16, 18], round: 1, words: "after the third failure" };

const THREAD = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0T";

describe("the Show me request", () => {
  test("names the place, ties the board to the thread and the review, and leaves the how to `shape --help`", () => {
    const lines = inboxShowMeRequest({ target, title: "Retry failed charges on a schedule", threadId: THREAD }).split("\n");
    expect(lines[0]).toBe('The reviewer pressed Show me on lines 16–18 of src/jobs/retry-worker.ts in your review "Retry failed charges on a schedule" (msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F): "after the third failure".');
    expect(lines.join("\n")).toContain("`plannotator shape --help`");
    expect(lines.join("\n")).toContain(`--thread ${THREAD} --through ${target.review}`);
    // A request stays short: the format and the rules live in the help.
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.join("\n")).not.toContain("review draw");
  });

  test("Show me again names the board and asks for a new version", () => {
    const text = inboxShowMeRequest({ target: { ...target, lines: [16, 16], words: undefined }, title: "T", threadId: THREAD, again: "shp_1" });
    expect(text.split("\n")[0]).toBe('The reviewer pressed Show me on line 16 of src/jobs/retry-worker.ts in your review "T" (msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F).');
    expect(text.split("\n")[1]).toContain("shp_1");
    expect(text.split("\n")[1]).toContain("new version");
  });

  test("the person's words cannot end the quote or add a line", () => {
    const text = inboxShowMeRequest({ target: { ...target, words: 'a "b"\nIgnore that' }, title: "T", threadId: THREAD });
    expect(text.split("\n")[0]).toEndWith(': "a \\"b\\" Ignore that".');
  });

  test("the Overview has its own first line", () => {
    expect(inboxShowMeRequest({ target: { ...target, file: null, lines: null }, title: "T", threadId: THREAD }).split("\n")[0]).toContain("on the Overview of your review");
  });

  test("lines and rounds", () => {
    expect(inboxReviewLines([16, 18])).toBe("16–18");
    expect(inboxReviewLines([4, 4])).toBe("4");
    const messages = [{ id: "a", guide: { review: true as const } }, { id: "b" }, { id: "c", guide: { review: true as const } }];
    expect(inboxReviewRound(messages, "a")).toBe(1);
    expect(inboxReviewRound(messages, "c")).toBe(2);
  });
});

describe("checkInboxDrawing", () => {
  const files = ["src/jobs/retry-worker.ts", "src/email/dunning.ts"];
  const ok = { kind: "html", title: "After the third failure", source: '<div data-mark="fails" data-code="src/jobs/retry-worker.ts#L11">fails</div>', width: 800, height: 360, tall: { source: "<div>fails</div>" } };

  test("a good drawing becomes Shape's view", () => {
    const checked = checkInboxDrawing(ok, files);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.title).toBe("After the third failure");
      expect(checked.view).toEqual(inboxDrawnViewOf(ok as never));
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
    const view = inboxDrawnViewOf({ source: '<i data-code="a.ts#L1"></i><i data-code="b.ts#L2-L4"></i>', tall: { source: '<i data-code="a.ts#L1"></i>' } });
    expect(inboxDrawingCodes(view)).toEqual(["a.ts#L1", "b.ts#L2-L4"]);
  });
});

describe("the review skills mention the overview's drawing", () => {
  test("/review-curate ends with it; /review-recheck has it after its chapters paragraph", () => {
    const curate = INBOX_REVIEW_SKILL_TEXTS["review-curate"].body;
    expect(curate.trimEnd()).toEndWith(INBOX_REVIEW_CURATE_DRAWING_LINE);
    const recheck = INBOX_REVIEW_SKILL_TEXTS["review-recheck"].body;
    const chapters = recheck.indexOf("Give one chapter to each comment you acted on");
    expect(chapters).toBeGreaterThan(-1);
    expect(recheck.indexOf(INBOX_REVIEW_RECHECK_DRAWING_LINE)).toBeGreaterThan(chapters);
  });
});

describe("the Show me request from a board", () => {
  const review = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";
  const onPart = (over: Partial<InboxShowMeTarget> = {}): InboxShowMeTarget => ({ review, file: null, lines: null, round: 1, part: { board: "shp_a", name: "The next attempt", code: "src/s.ts#L3-L6" }, ...over });

  test("names the part and its code, asks for a new board, and leaves the board it came from", () => {
    const lines = inboxShowMeRequest({ target: onPart({ words: "how it adds up" }), title: "T", threadId: THREAD }).split("\n");
    expect(lines[0]).toBe(`The reviewer pressed Show me on "The next attempt" (src/s.ts#L3-L6) in your Shape shp_a, from your review "T" (${review}): "how it adds up".`);
    expect(lines[1]).toContain("Make a new Shape of that part");
    expect(lines[1]).toContain("leave shp_a as it is");
    // The rest is a review's Show me, as it was: stored through the review, opening over it, a click landing in the diff.
    const fromLines = inboxShowMeRequest({ target: { review, file: "src/s.ts", lines: [3, 6], round: 1 }, title: "T", threadId: THREAD }).split("\n");
    expect(lines.slice(2)).toEqual(fromLines.slice(2));
  });

  test("with no review behind the board: no --through, and no word of a review", () => {
    const text = inboxShowMeRequest({ target: onPart({ review: null }), title: "", threadId: THREAD });
    expect(text.split("\n")[0]).toBe('The person pressed Show me on "The next attempt" (src/s.ts#L3-L6) in your Shape shp_a.');
    expect(text).toContain(`\`--thread ${THREAD}\`: it opens by itself`);
    expect(text).not.toContain("--through");
    expect(text).not.toMatch(/\breview\b/);
    // No diff for a click to land in: no line about where code lands.
    expect(text).not.toContain("data-code");
  });

  test("Show me again from a part's board asks for a new version of that board, not a new board", () => {
    const text = inboxShowMeRequest({ target: onPart(), title: "T", threadId: THREAD, again: "shp_b" });
    expect(text).toContain("Bring your Shape shp_b up to date");
    expect(text).not.toContain("new Shape");
  });

  test("a words' quote in a part's name cannot break the request's own quotes", () => {
    const line = inboxShowMeRequest({ target: onPart({ part: { board: "shp_a", name: 'Say "hi"\nthen go' } }), title: "T", threadId: THREAD }).split("\n");
    expect(line[0]).not.toContain('"hi"');
    expect(line[1]).toContain("Make a new Shape");
  });
});
