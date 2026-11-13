/**
 * Who still gets the Priority dialog (inbox-priority-intro.ts). What regresses: a person who added a thread to
 * Priority, then removed it (priority.json gone), getting the dialog anyway; a thread in Priority from before the key
 * not counting; the first use's stamp being rewritten by a later change, or written while nothing was added; the
 * dialog showing on the day the Inbox first ran a version that has it (the owner: "Hold it back a day after an
 * upgrade"), or not on the next day. No Inbox is started.
 */
import { describe, expect, test } from "bun:test";
import { priorityIntroOpen, priorityIntroUsed } from "./inbox-priority-intro";

// Local times: the hold is by the person's calendar day.
const NOW = new Date(2026, 10, 13, 15, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
/** The version that has it first ran two days ago. */
const KNOWN = at(11, 9);

describe("open", () => {
  test("open only while the person never added a thread to Priority", () => {
    expect(priorityIntroOpen(undefined, 0, KNOWN, NOW)).toBe(true);
    expect(priorityIntroOpen({}, 0, KNOWN, NOW)).toBe(true);
    expect(priorityIntroOpen(undefined, 1, KNOWN, NOW)).toBe(false);
    expect(priorityIntroOpen({ usedAt: "2026-11-10T09:00:00.000Z" }, 0, KNOWN, NOW)).toBe(false);
  });

  test("held back on the day the Inbox first ran a version that has it, open from the next calendar day", () => {
    // Upgraded this morning: not today, even late in the day.
    expect(priorityIntroOpen(undefined, 0, at(13, 0), NOW)).toBe(false);
    expect(priorityIntroOpen(undefined, 0, at(13, 9), new Date(2026, 10, 13, 23, 59))).toBe(false);
    // The next day, even just after midnight.
    expect(priorityIntroOpen(undefined, 0, at(12, 23), new Date(2026, 10, 13, 0, 1))).toBe(true);
    expect(priorityIntroOpen(undefined, 0, at(12, 9), NOW)).toBe(true);
  });

  test("no first start stamped yet (a dev build stamps none): closed", () => {
    expect(priorityIntroOpen(undefined, 0, undefined, NOW)).toBe(false);
    expect(priorityIntroOpen(undefined, 0, "not a time", NOW)).toBe(false);
  });
});

describe("used", () => {
  test("the first add is stamped once; later changes keep that stamp", () => {
    const first = priorityIntroUsed(undefined, 1, NOW);
    expect(first).toEqual({ usedAt: NOW.toISOString() });
    expect(priorityIntroUsed(first!, 2, new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(priorityIntroUsed(first!, 0, new Date(NOW.getTime() + 60_000))).toBeNull();
  });

  test("a change with no add standing (a remove of an agent's ask, an Undo before any add) stamps nothing", () => {
    expect(priorityIntroUsed(undefined, 0, NOW)).toBeNull();
  });

  test("added, then removed: still used, so never open again", () => {
    const saved = priorityIntroUsed(undefined, 1, NOW)!;
    expect(priorityIntroOpen(saved, 0, KNOWN, NOW)).toBe(false);
  });
});
