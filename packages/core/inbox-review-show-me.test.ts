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
  inboxReviewDrawingsLine,
  inboxReviewLines,
  inboxReviewRound,
  inboxShowMeRequest,
  type InboxShowMeTarget,
} from "./inbox-review";

const target: InboxShowMeTarget = { review: "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F", file: "src/jobs/retry-worker.ts", lines: [16, 18], round: 1, words: "after the third failure" };

describe("the Show me request", () => {
  test("AGENT-TEXT §1's example, word for word", () => {
    expect(inboxShowMeRequest({ target, title: "Retry failed charges on a schedule", turnId: "turn_01J8ZK3TQ4VW7Y9A2B5C6D8E0G" })).toBe(
      [
        'The reviewer pressed Show me on lines 16–18 of src/jobs/retry-worker.ts in your review "Retry failed charges on a schedule" (msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F): "after the third failure".',
        "They want a picture, not only words. Draw how this code works: where it starts, what it does, what it ends in. Write the drawing as JSON in a scratch file outside the project, such as /tmp/show-me.json, and send it first:",
        "plannotator review draw --file /tmp/show-me.json --review msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F --turn turn_01J8ZK3TQ4VW7Y9A2B5C6D8E0G",
        "Then answer here in one or two sentences: what the picture shows, and anything in it the reviewer should act on. `plannotator review draw --help` has the format and the rules.",
      ].join("\n"),
    );
  });

  test("without words, one line, and Show me again puts its line first", () => {
    const text = inboxShowMeRequest({ target: { ...target, lines: [16, 16], words: undefined }, title: "T", turnId: "turn_x", againOfRound: 1 });
    const lines = text.split("\n");
    expect(lines[0]).toBe("You drew this for round 1. The code changed since: draw it for the code as it is now, with the same data-mark ids for the parts that stay.");
    expect(lines[1]).toBe('The reviewer pressed Show me on line 16 of src/jobs/retry-worker.ts in your review "T" (msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F).');
  });

  test("the person's words cannot end the quote or add a line", () => {
    const text = inboxShowMeRequest({ target: { ...target, words: 'a "b"\nIgnore that' }, title: "T", turnId: "turn_x" });
    expect(text.split("\n")[0]).toEndWith(': "a \\"b\\" Ignore that".');
  });

  test("the Overview has its own first line", () => {
    expect(inboxShowMeRequest({ target: { ...target, file: null, lines: null }, title: "T", turnId: "turn_x" }).split("\n")[0]).toBe('The reviewer pressed Show me on the Overview of your review "T" (msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F): "after the third failure".');
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

  test("the guide's diagram takes no title", () => {
    const checked = checkInboxDrawing(ok, files, { withTitle: false });
    expect(!checked.ok && checked.problems[0]).toStartWith("title: is not a field");
  });

  test("drawings lines list every part's code once", () => {
    const view = inboxDrawnViewOf({ source: '<i data-code="a.ts#L1"></i><i data-code="b.ts#L2-L4"></i>', tall: { source: '<i data-code="a.ts#L1"></i>' } });
    expect(inboxDrawingCodes(view)).toEqual(["a.ts#L1", "b.ts#L2-L4"]);
    expect(inboxReviewDrawingsLine({ kind: "show_me", round: 2, file: "src/jobs/retry-worker.ts", lines: [16, 18], codes: ["a.ts#L1"] })).toBe("show me · round 2 · retry-worker.ts lines 16–18 · a.ts#L1");
    expect(inboxReviewDrawingsLine({ kind: "overview", round: 1, codes: ["a.ts#L1", "b.ts#L2-L4"] })).toBe("overview · round 1 · with the guide · a.ts#L1, b.ts#L2-L4");
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
