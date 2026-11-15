/**
 * Who the one-time "themes" dialog is for, and its place in the line (approval "inbox-theme-chooser", 2026-11-10).
 *
 * What regresses: the dialog due for someone on another theme (the owner: "they don't need to choose, we don't need to
 * show them this"), or for someone who went back to the default theme after picking one; someone who only flipped
 * light and dark losing it; the dialog offered before the tab icon dialog, or sooner than the line's gap after it (the
 * owner, 2026-11-10; the gap is the line's own, 40 minutes); the dialog behind an offer, or held back on day one; a Not now accepted for it.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVEALS, REVEAL_SPACING_MS, revealAgainAt, revealMayClaim, revealNext, revealNotNowAllowed, revealQualifies, type RevealId, type RevealState } from "./reveals";
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
  const MINUTE = 60_000;
  const everything = Object.fromEntries(INBOX_REVEALS.map((entry) => [entry.id, true])) as Record<RevealId, boolean>;
  const only = (...ids: RevealId[]) => Object.fromEntries(ids.map((id) => [id, true])) as Partial<Record<RevealId, boolean>>;
  const state = (over: Partial<RevealState> = {}): RevealState => ({ release: true, firstUseAt: "2026-10-01T09:00:00.000", threads: 40, heavy: true, open: everything, ...over });
  const now = new Date("2026-11-10T15:00:00.000");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  test("right after the tab icon dialog (the owner: \"The favicon one should come first\"), ahead of every offer behind it", () => {
    const ids = INBOX_REVEALS.map((entry) => entry.id);
    expect(ids.indexOf("theme_chooser")).toBe(ids.indexOf("tab_icon") + 1);
    expect(revealNext(state({ open: only("tab_icon", "theme_chooser", "snooze", "board") }), now)).toBe("tab_icon");
    expect(revealMayClaim("theme_chooser", state({ open: only("tab_icon", "theme_chooser") }), now)).toBe(false);
    // The tab icon dialog done (or never theirs): it is next, ahead of Snooze, the Board and the rest.
    expect(revealNext(state({ open: only("theme_chooser", "snooze", "bro", "board", "steps", "list_view") }), now)).toBe("theme_chooser");
    // Not for them (another theme): the line is as it was.
    expect(revealNext(state({ open: only("snooze", "board") }), now)).toBe("snooze");
  });

  test("the line's own gap after the tab icon dialog showed, not before (the owner: \"like thirty minutes after\"; no number of its own)", () => {
    const after = (ms: number) => revealNext(state({ open: only("theme_chooser"), lastShownAt: ago(ms), dayShownAt: ago(ms) }), now);
    expect(after(REVEAL_SPACING_MS - 1)).toBeNull();
    expect(after(REVEAL_SPACING_MS)).toBe("theme_chooser");
    // The same gap from any other dialog or tip: the agent note, the star ask, the Sidebar tip.
    expect(revealNext(state({ open: only("theme_chooser"), dayShownAt: ago(10 * MINUTE) }), now)).toBeNull();
    expect(revealNext(state({ open: only("theme_chooser"), asideShownAt: ago(10 * MINUTE) }), now)).toBeNull();
    expect(revealNext(state({ open: only("theme_chooser"), tipShownAt: ago(10 * MINUTE) }), now)).toBeNull();
    // And the page is told when to ask again: the end of that gap.
    expect(revealAgainAt(state({ open: only("theme_chooser"), lastShownAt: ago(10 * MINUTE) }), now)).toBe(now.getTime() + REVEAL_SPACING_MS - 10 * MINUTE);
  });

  test("from day one: no tenure, no thread minimum, first use not known yet; and no Not now (every way out is final)", () => {
    const entry = INBOX_REVEALS.find((e) => e.id === "theme_chooser")!;
    expect(revealQualifies(entry, state({ firstUseAt: null, threads: 0, open: only("theme_chooser") }), now)).toBe(true);
    expect(revealNext(state({ firstUseAt: now.toISOString(), threads: 0, open: only("theme_chooser") }), now)).toBe("theme_chooser");
    // Code review's day-0 offer keeps its place ahead of it.
    expect(revealNext(state({ firstUseAt: null, threads: 0, open: only("code_review", "theme_chooser") }), now)).toBe("code_review");
    expect(revealNotNowAllowed("theme_chooser")).toBe(false);
  });
});
