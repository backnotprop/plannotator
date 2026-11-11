/**
 * The Sidebar tip's rule on the Inbox (sidebar-tip.ts), with no Inbox. What regresses: it shown to someone who already customized the sidebar (also after they set it back to the default); it shown
 * on the person's first day; a second window or the phone shown it after the stamp; the claiming page's retry after a
 * lost answer losing it, or writing again.
 */
import { describe, expect, test } from "bun:test";
import { sidebarTipClaim, sidebarTipDue, type SidebarTipState } from "./sidebar-tip";

const AT = "2026-11-09T10:00:00.000Z";
const TWO_DAYS_BEFORE = "2026-11-07T10:00:00.000Z";
const fresh: SidebarTipState = { customized: false, firstUseAt: TWO_DAYS_BEFORE, tenure: true, saved: undefined };

describe("sidebarTipDue", () => {
  test("a day or more after first use, the sidebar never customized, never shown", () => {
    expect(sidebarTipDue(fresh, AT)).toBe(true);
    expect(sidebarTipDue({ ...fresh, firstUseAt: "2026-11-08T10:00:00.000Z" }, AT)).toBe(true);
  });
  test("never once the sidebar was customized, never once shown", () => {
    expect(sidebarTipDue({ ...fresh, customized: true }, AT)).toBe(false);
    expect(sidebarTipDue({ ...fresh, saved: { shownAt: AT } }, AT)).toBe(false);
    // A key alone (no stamp) is not a show.
    expect(sidebarTipDue({ ...fresh, saved: { key: "page-key-1" } }, AT)).toBe(true);
  });
  test("never on the first day, nor before first use is known; a dev build keeps no first use and asks for none", () => {
    expect(sidebarTipDue({ ...fresh, firstUseAt: "2026-11-08T10:00:01.000Z" }, AT)).toBe(false);
    expect(sidebarTipDue({ ...fresh, firstUseAt: null }, AT)).toBe(false);
    expect(sidebarTipDue({ ...fresh, firstUseAt: "not a time" }, AT)).toBe(false);
    expect(sidebarTipDue({ ...fresh, firstUseAt: null, tenure: false }, AT)).toBe(true);
  });
});

describe("sidebarTipClaim", () => {
  test("the first claim shows it and stamps it with the page's key", () => {
    expect(sidebarTipClaim(fresh, "page-key-1", AT)).toEqual({ show: true, save: { shownAt: AT, key: "page-key-1" } });
    expect(sidebarTipClaim(fresh, null, AT)).toEqual({ show: true, save: { shownAt: AT } });
  });
  test("once stamped: the same key is shown it again with no write; any other claim gets no", () => {
    const stamped: SidebarTipState = { ...fresh, saved: { shownAt: AT, key: "page-key-1" } };
    expect(sidebarTipClaim(stamped, "page-key-1", "2026-11-09T10:00:02.000Z")).toEqual({ show: true, save: null });
    expect(sidebarTipClaim(stamped, "phone-key-2", AT)).toEqual({ show: false, save: null });
    expect(sidebarTipClaim(stamped, null, AT)).toEqual({ show: false, save: null });
  });
  test("customized between the settings read and the claim: no show and no stamp, for the retry too", () => {
    expect(sidebarTipClaim({ ...fresh, customized: true }, "page-key-1", AT)).toEqual({ show: false, save: null });
    expect(sidebarTipClaim({ ...fresh, customized: true, saved: { shownAt: AT, key: "page-key-1" } }, "page-key-1", AT)).toEqual({ show: false, save: null });
  });
  test("a first-day claim is refused unstamped", () => {
    expect(sidebarTipClaim({ ...fresh, firstUseAt: AT }, "page-key-1", AT)).toEqual({ show: false, save: null });
  });
});
