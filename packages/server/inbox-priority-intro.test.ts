/**
 * Who still gets the Priority dialog (inbox-priority-intro.ts). What regresses: a person who added a thread to
 * Priority, then removed it (priority.json gone), getting the dialog anyway; a thread in Priority from before the key
 * not counting; the first use's stamp being rewritten by a later change, or written while nothing was added.
 * No Inbox is started.
 */
import { describe, expect, test } from "bun:test";
import { priorityIntroOpen, priorityIntroUsed } from "./inbox-priority-intro";

const NOW = new Date("2026-11-13T15:00:00.000Z");

describe("open", () => {
  test("open only while the person never added a thread to Priority", () => {
    expect(priorityIntroOpen(undefined, 0)).toBe(true);
    expect(priorityIntroOpen({}, 0)).toBe(true);
    expect(priorityIntroOpen(undefined, 1)).toBe(false);
    expect(priorityIntroOpen({ usedAt: "2026-11-10T09:00:00.000Z" }, 0)).toBe(false);
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
    expect(priorityIntroOpen(saved, 0)).toBe(false);
  });
});
