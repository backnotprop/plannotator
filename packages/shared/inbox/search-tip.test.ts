/**
 * The Search tip's rule on the Inbox (search-tip.ts), with no Inbox. What regresses: it shown to someone whose recent
 * searches already hold a quote; it shown on the person's first day; a second window or the phone shown it after the
 * stamp; the claiming page's retry after a lost answer losing it, or writing again.
 */
import { describe, expect, test } from "bun:test";
import { inboxSearchQuoted } from "@plannotator/core/inbox-search";
import { searchTipClaim, searchTipDue, type SearchTipState } from "./search-tip";

const AT = "2026-11-27T10:00:00.000Z";
const TWO_DAYS_BEFORE = "2026-11-25T10:00:00.000Z";
const fresh: SearchTipState = { quoted: false, firstUseAt: TWO_DAYS_BEFORE, tenure: true, saved: undefined };

describe("searchTipDue", () => {
  test("a day or more after first use, no quoted search, never shown", () => {
    expect(searchTipDue(fresh, AT)).toBe(true);
    expect(searchTipDue({ ...fresh, firstUseAt: "2026-11-26T10:00:00.000Z" }, AT)).toBe(true);
  });
  test("never for someone who already searched with quotes, never once shown", () => {
    expect(searchTipDue({ ...fresh, quoted: true }, AT)).toBe(false);
    expect(searchTipDue({ ...fresh, saved: { shownAt: AT } }, AT)).toBe(false);
    // A key alone (no stamp) is not a show.
    expect(searchTipDue({ ...fresh, saved: { key: "page-key-1" } }, AT)).toBe(true);
  });
  test("never on the first day, nor before first use is known; a dev build keeps no first use and asks for none", () => {
    expect(searchTipDue({ ...fresh, firstUseAt: "2026-11-26T10:00:01.000Z" }, AT)).toBe(false);
    expect(searchTipDue({ ...fresh, firstUseAt: null }, AT)).toBe(false);
    expect(searchTipDue({ ...fresh, firstUseAt: null, tenure: false }, AT)).toBe(true);
  });
});

describe("searchTipClaim", () => {
  test("the first claim shows it and stamps it with the page's key", () => {
    expect(searchTipClaim(fresh, "page-key-1", AT)).toEqual({ show: true, save: { shownAt: AT, key: "page-key-1" } });
    expect(searchTipClaim(fresh, null, AT)).toEqual({ show: true, save: { shownAt: AT } });
  });
  test("once stamped: the same key is shown it again with no write; any other claim gets no", () => {
    const stamped: SearchTipState = { ...fresh, saved: { shownAt: AT, key: "page-key-1" } };
    expect(searchTipClaim(stamped, "page-key-1", "2026-11-27T10:00:02.000Z")).toEqual({ show: true, save: null });
    expect(searchTipClaim(stamped, "phone-key-2", AT)).toEqual({ show: false, save: null });
    expect(searchTipClaim(stamped, null, AT)).toEqual({ show: false, save: null });
  });
  test("a quoted search or the first day refuses the claim, writing nothing", () => {
    expect(searchTipClaim({ ...fresh, quoted: true }, "page-key-1", AT)).toEqual({ show: false, save: null });
    expect(searchTipClaim({ ...fresh, firstUseAt: AT }, "page-key-1", AT)).toEqual({ show: false, save: null });
  });
});

describe("a quoted search, as the server reads the recent searches", () => {
  test("any quote mark the search treats as one counts: straight, curly, German and French", () => {
    for (const q of ['"file viewer"', "“file viewer”", "„Datei“", "«fichier»", 'half "open']) expect(inboxSearchQuoted(q)).toBe(true);
    for (const q of ["file viewer", "O'Brien", "rate lim"]) expect(inboxSearchQuoted(q)).toBe(false);
  });
});
