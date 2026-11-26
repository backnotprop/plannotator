/**
 * The launch dialog ahead of the Inbox's line (reveals.ts `launchDue`).
 *
 * What regresses: an offer, an update-day dialog, the star ask, the agent note or a tip armed or claimed while the
 * launch dialog is due on this computer (two dialogs on one load); the line staying held once it is not due.
 */
import { describe, expect, test } from "bun:test";
import { revealAhead, revealAsideNow, revealLineFree, revealMayClaim, revealNext, type RevealState } from "./reveals";

const now = new Date("2026-12-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const state = (launchDue: boolean): RevealState => ({
  release: true,
  firstUseAt: new Date(now.getTime() - 10 * DAY).toISOString(),
  threads: 20,
  open: { tab_icon: true, board: true, view_choice: true, star: true },
  launchDue,
});

describe("the launch dialog holds the line while it is due", () => {
  test("nothing next, ahead, aside or claimable, and no setup or tip", () => {
    const due = state(true);
    expect(revealNext(due, now)).toBeNull();
    expect(revealAhead(due, now)).toEqual([]);
    expect(revealAsideNow(due, now)).toEqual([]);
    expect(revealMayClaim("tab_icon", due, now)).toBe(false);
    expect(revealMayClaim("star", due, now)).toBe(false);
    expect(revealLineFree("setup", due, now)).toBe(false);
    // A dev build keeps no line, but the launch dialog still goes first.
    expect(revealLineFree("setup", { ...due, release: false }, now)).toBe(false);
  });

  test("not due: the line as before", () => {
    const free = state(false);
    expect(revealNext(free, now)).toBe("tab_icon");
    expect(revealMayClaim("tab_icon", free, now)).toBe(true);
    expect(revealLineFree("setup", free, now)).toBe(true);
  });
});
