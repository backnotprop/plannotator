/**
 * The grill-me tip's need (grill-me-tip.ts `revealGrillMeGap`): someone who answered 3 question cards or more,
 * whatever the days or threads (the owner, 2026-11-08: "Sooner: after 3 answered questions, whatever the days,
 * once"), and never ran grill-me. What regresses: the tip for someone who answered fewer, whose skips were counted, or
 * who already runs grill-me; or held back for answers in one thread or on one day.
 */
import { describe, expect, test } from "bun:test";
import { revealGrillMeGap, type GrillMeTipQuestion, type GrillMeTipUse } from "./grill-me-tip";

const answered = (over: Partial<GrillMeTipQuestion> = {}): GrillMeTipQuestion => ({
  kind: "single",
  answer: { skipped: false },
  revision: 1,
  sent_revision: 1,
  ...over,
});

const use = (questions: GrillMeTipQuestion[], over: Partial<GrillMeTipUse> = {}): GrillMeTipUse => ({
  questions,
  skills: [],
  texts: ["Dark mode", null, "Which way should the toggle go?"],
  ...over,
});

/** Met: 3 answers. */
const MET = [answered(), answered(), answered()];

describe("the gap", () => {
  test("met: 3 answered question blocks, in one thread on one day or anywhere, and no sign of grill-me", () => {
    expect(revealGrillMeGap(use(MET))).toBe(true);
  });

  test("2 answered: no", () => {
    expect(revealGrillMeGap(use(MET.slice(0, 2)))).toBe(false);
  });

  test("skips, unsent picks, picks changed after sending, action items, replaced or set-aside questions do not count", () => {
    for (const notAnswer of [
      { answer: { skipped: true } },
      { answer: null },
      { revision: 2, sent_revision: 1 },
      { revision: 0, sent_revision: 0 },
      { kind: "action" },
      { superseded_by: { message_id: "m9" } },
      { set_aside: { at: "2026-11-04T10:00:00.000Z" } },
    ] satisfies Partial<GrillMeTipQuestion>[]) {
      expect(revealGrillMeGap(use([MET[0]!, MET[1]!, answered(notAnswer)]))).toBe(false);
    }
  });
});

describe("someone who already runs grill-me: never", () => {
  test("a thread subject or name, or an agent message, that says grill-me or grilling", () => {
    for (const text of ["Grill me on the auth plan", "grill-me: dark mode", "grill_me round 2", "grillme", "Grilling the release plan", "I'll keep grilling you on this"]) {
      expect(revealGrillMeGap(use(MET, { texts: ["Dark mode", text] }))).toBe(false);
    }
  });

  test("a skills block of theirs that named a grill-me skill, whoever wrote it", () => {
    for (const skill of ["grill-me", "team:grill-me", "GrillMe", "grilling", "grill-with-docs"]) {
      expect(revealGrillMeGap(use(MET, { skills: ["release-notes", skill] }))).toBe(false);
    }
  });

  test("other skills and words do not stop it", () => {
    expect(revealGrillMeGap(use(MET, { skills: ["release-notes", "grilled-cheese"], texts: ["The grill is hot", "Me first"] }))).toBe(true);
  });
});

test("fewer than 3 answers: no message is read at all (the server walks the store lazily)", () => {
  let read = false;
  const texts = (function* () {
    read = true;
    yield "Dark mode";
  })();
  expect(revealGrillMeGap(use([answered(), answered()], { texts }))).toBe(false);
  expect(read).toBe(false);
});

test("3 answers found: the walk of question blocks stops there", () => {
  let walked = 0;
  const questions = (function* () {
    for (;;) {
      walked += 1;
      yield answered();
    }
  })();
  expect(revealGrillMeGap(use([], { questions }))).toBe(true);
  expect(walked).toBe(3);
});
