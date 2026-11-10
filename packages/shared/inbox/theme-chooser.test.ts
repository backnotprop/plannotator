/**
 * Who the one-time "themes" dialog is for, and its place in the line (approval "inbox-theme-chooser", 2026-11-10).
 *
 * What regresses: the dialog due for someone on another theme (the owner: "they don't need to choose, we don't need to
 * show them this"), or for someone who went back to the default theme after picking one; someone who only flipped
 * light and dark losing it; the dialog not at the front of the line for a person who qualifies; the dialog on day 0,
 * ahead of Code review's "immediately" offer; a Not now accepted for it.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVEALS, revealNext, revealNotNowAllowed, revealQualifies, type RevealId, type RevealState } from "./reveals";
import { themeChooserLook, themeChooserOnDefault, themeChooserOpen } from "./theme-chooser";

const AT = "2026-11-10T09:00:00.000Z";
const LATER = "2026-11-12T09:00:00.000Z";

describe("who it is for", () => {
  test("the default theme is Plannotator Original on both halves, whatever the mode", () => {
    expect(themeChooserOnDefault(undefined)).toBe(true);
    expect(themeChooserOnDefault(null)).toBe(true);
    expect(themeChooserOnDefault({})).toBe(true);
    expect(themeChooserOnDefault({ mode: "dark" })).toBe(true);
    expect(themeChooserOnDefault({ mode: "system", light: "plannotator", dark: "plannotator" })).toBe(true);
    expect(themeChooserOnDefault({ light: "plannotator-modern" })).toBe(false);
    expect(themeChooserOnDefault({ light: "plannotator", dark: "tokyo-night" })).toBe(false);
  });

  test("decided once: due on the default theme, marked as not needed on any other", () => {
    expect(themeChooserLook(undefined, undefined, AT)).toEqual({ dueAt: AT });
    expect(themeChooserLook(undefined, { mode: "light" }, AT)).toEqual({ dueAt: AT });
    expect(themeChooserLook(undefined, { dark: "nord" }, AT)).toEqual({ notNeededAt: AT });
    // Decided: a later look on the same theme writes nothing.
    expect(themeChooserLook({ dueAt: AT }, { mode: "dark" }, LATER)).toBeNull();
    expect(themeChooserLook({ notNeededAt: AT }, { dark: "nord" }, LATER)).toBeNull();
  });

  test("a theme picked after it was due marks it as not needed, for good: back on the default theme it stays closed", () => {
    const due = { dueAt: AT };
    expect(themeChooserOpen(due, undefined)).toBe(true);
    expect(themeChooserOpen(due, { light: "plannotator-modern", dark: "plannotator-modern" })).toBe(false);
    const marked = themeChooserLook(due, { light: "plannotator-modern", dark: "plannotator-modern" }, LATER);
    expect(marked).toEqual({ dueAt: AT, notNeededAt: LATER });
    expect(themeChooserOpen(marked!, { light: "plannotator", dark: "plannotator" })).toBe(false);
    expect(themeChooserLook(marked!, { light: "plannotator", dark: "plannotator" }, LATER)).toBeNull();
    // Never decided (a dev build, an older Inbox): closed.
    expect(themeChooserOpen(undefined, undefined)).toBe(false);
  });
});

describe("its place in the line", () => {
  const everything = Object.fromEntries(INBOX_REVEALS.map((entry) => [entry.id, true])) as Record<RevealId, boolean>;
  const state = (over: Partial<RevealState> = {}): RevealState => ({ release: true, firstUseAt: "2026-10-01T09:00:00.000", threads: 40, heavy: true, open: everything, ...over });
  const now = new Date("2026-11-10T15:00:00.000");

  test("at the front: next for someone who qualifies, with every other dialog of the line open too", () => {
    expect(INBOX_REVEALS[0]!.id).toBe("theme_chooser");
    expect(revealNext(state(), now)).toBe("theme_chooser");
    // Not for them (another theme): the line is as it was.
    expect(revealNext(state({ open: { ...everything, theme_chooser: false } }), now)).toBe("code_review");
  });

  test("never on the first day of use: day 0 stays setup's, and Code review's offer keeps its place", () => {
    const sameDay = state({ firstUseAt: "2026-11-10T09:00:00.000" });
    expect(revealQualifies(INBOX_REVEALS[0]!, sameDay, now)).toBe(false);
    expect(revealNext(sameDay, now)).toBe("code_review");
    // First use not known yet (a fresh install, nothing in the store).
    expect(revealNext(state({ firstUseAt: null }), now)).toBe("code_review");
    // The next local day: it is at the front.
    expect(revealNext(sameDay, new Date("2026-11-11T08:00:00.000"))).toBe("theme_chooser");
  });

  test("no thread minimum, and no Not now (every way out is final)", () => {
    expect(revealNext(state({ threads: 0 }), now)).toBe("theme_chooser");
    expect(revealNotNowAllowed("theme_chooser")).toBe(false);
  });
});
