/**
 * The grill-me tip's need (grill-me-tip.ts `revealGrillMeGap`): someone who answers question cards (3 or more, in 2
 * threads or more, on 2 local days or more) and never ran grill-me. What regresses: the tip for someone who barely
 * answered, who answered in one thread or on one day, whose skips were counted, or who already runs grill-me.
 */
import { describe, expect, test } from "bun:test";
import { revealGrillMeGap, type GrillMeTipQuestion, type GrillMeTipUse } from "./grill-me-tip";

/** Local time, day `day` of November 2026. */
const on = (day: number, hour = 10) => new Date(2026, 10, day, hour).toISOString();

const answered = (threadId: string, at: string, over: Partial<GrillMeTipQuestion> = {}): GrillMeTipQuestion => ({
  threadId,
  at,
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

/** Met: 3 answers, 2 threads, 2 days. */
const MET = [answered("t1", on(3)), answered("t1", on(3, 15)), answered("t2", on(4))];

describe("the gap", () => {
  test("met: 3 answered question blocks, in 2 threads, on 2 days, and no sign of grill-me", () => {
    expect(revealGrillMeGap(use(MET))).toBe(true);
  });

  test("2 answered: no", () => {
    expect(revealGrillMeGap(use(MET.slice(0, 2)))).toBe(false);
    expect(revealGrillMeGap(use([answered("t1", on(3)), answered("t2", on(4))]))).toBe(false);
  });

  test("3 answered in one thread, on 3 days: no", () => {
    expect(revealGrillMeGap(use([answered("t1", on(3)), answered("t1", on(4)), answered("t1", on(5))]))).toBe(false);
  });

  test("3 answered across 2 threads on one local day: no", () => {
    expect(revealGrillMeGap(use([answered("t1", on(3, 9)), answered("t2", on(3, 13)), answered("t2", on(3, 22))]))).toBe(false);
  });

  test("skips, unsent picks, picks changed after sending, action items, replaced or set-aside questions do not count", () => {
    for (const notAnswer of [
      { answer: { skipped: true } },
      { answer: null },
      { revision: 2, sent_revision: 1 },
      { revision: 0, sent_revision: 0 },
      { kind: "action" },
      { superseded_by: { message_id: "m9" } },
      { set_aside: { at: on(4) } },
    ] satisfies Partial<GrillMeTipQuestion>[]) {
      expect(revealGrillMeGap(use([MET[0]!, MET[1]!, answered("t2", on(4), notAnswer)]))).toBe(false);
    }
  });

  test("an answer with no time does not count toward its day", () => {
    expect(revealGrillMeGap(use([MET[0]!, MET[1]!, answered("t2", null as unknown as string)]))).toBe(false);
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
  expect(revealGrillMeGap(use([answered("t1", on(3))], { texts }))).toBe(false);
  expect(read).toBe(false);
});
