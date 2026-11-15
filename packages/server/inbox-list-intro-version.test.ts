/**
 * Who gets "Choose how your list looks" at a release start (inbox-list-intro.ts; approval "inbox-rows-dialog"). Pure:
 * no Inbox starts. What regresses: someone who saw the 0.28.42 dialog never seeing the new one, anyone seeing it twice
 * (each later start must leave a decided record alone, claimed or not), a fresh install left out, or version 1's
 * record cleared instead of kept; someone who already picked a look still being asked (the owner, 2026-11-09: "Yes,
 * skip it for them"), or someone who never picked one being skipped (a record with no save, the old all-off default).
 */
import { describe, expect, test } from "bun:test";
import { LIST_INTRO_VERSION, listIntroAtStart, listIntroDue, listIntroLookPicked, type ListIntroSaved } from "./inbox-list-intro";

const AT = "2026-11-08T10:00:00.000Z";
const LATER = "2026-11-09T10:00:00.000Z";

/** One start, then the page's claim (the server's compare-and-set writes `shownAt`), then another start. */
function startClaimStart(saved: ListIntroSaved | undefined) {
  const first = listIntroAtStart(saved, AT) ?? saved;
  const claimed = { ...first, shownAt: LATER };
  return { first, claimed, again: listIntroAtStart(claimed, LATER) };
}

describe("the rows dialog's seen key", () => {
  test("saw the 0.28.42 dialog: due once more, version 1's record kept; after the claim no later start brings it back", () => {
    const v1: ListIntroSaved = { dueAt: "2026-11-02T09:00:00.000Z", shownAt: "2026-11-03T09:00:00.000Z" };
    const { first, again } = startClaimStart(v1);
    expect(first).toEqual({ dueAt: AT, version: LIST_INTRO_VERSION, before: v1 });
    expect(listIntroDue(first)).toBe(true);
    expect(again).toBeNull();
  });

  test("a fresh install (no record) and one marked shown by version 1 without a show: due too", () => {
    expect(listIntroAtStart(undefined, AT)).toEqual({ dueAt: AT, version: LIST_INTRO_VERSION });
    const marked = listIntroAtStart({ shownAt: "2026-11-01T09:00:00.000Z" }, AT);
    expect(marked).toEqual({ dueAt: AT, version: LIST_INTRO_VERSION, before: { shownAt: "2026-11-01T09:00:00.000Z" } });
    expect(listIntroDue(marked!)).toBe(true);
  });

  test("due but not claimed yet: a restart keeps the same record, so it stays due and is never doubled", () => {
    const first = listIntroAtStart(undefined, AT)!;
    expect(listIntroAtStart(first, LATER)).toBeNull();
    expect(listIntroDue(first)).toBe(true);
  });

  test("claimed: not due; never decided: not due", () => {
    expect(listIntroDue({ dueAt: AT, version: LIST_INTRO_VERSION, shownAt: LATER })).toBe(false);
    expect(listIntroDue(undefined)).toBe(false);
    expect(listIntroDue({ version: LIST_INTRO_VERSION, shownAt: LATER })).toBe(false);
  });
});

describe("who already picked a look (config.json inboxRows): the dialog has nothing to ask them", () => {
  test("a saved look is a pick, whichever look it is: the defaults saved from Settings count", () => {
    expect(listIntroLookPicked({ inboxRows: ["smallNames"], inboxRowsRev: 25 })).toBe(true);
    expect(listIntroLookPicked({ inboxRows: ["roomy", "previewTwo"], inboxRowsRev: 1, inboxRowsDefaults: 2 })).toBe(true);
    // Every option off, chosen since the defaults changed: the person's own.
    expect(listIntroLookPicked({ inboxRows: [], inboxRowsRev: 4, inboxRowsDefaults: 2 })).toBe(true);
  });

  test("never saved, a list no save wrote, or the old all-off default: not a pick", () => {
    expect(listIntroLookPicked({})).toBe(false);
    expect(listIntroLookPicked({ inboxRowsRev: 3 })).toBe(false);
    expect(listIntroLookPicked({ inboxRows: "roomy" as unknown as string[], inboxRowsRev: 3 })).toBe(false);
    // Hand-written, or restored without its count: no save made it.
    expect(listIntroLookPicked({ inboxRows: ["roomy"] })).toBe(false);
    expect(listIntroLookPicked({ inboxRows: ["roomy"], inboxRowsRev: 0 })).toBe(false);
    // Saved before the defaults changed with every option off: read as "never a choice" everywhere else too.
    expect(listIntroLookPicked({ inboxRows: [], inboxRowsRev: 2 })).toBe(false);
  });
});
