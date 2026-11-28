/**
 * The Group tip's rules (band-tip.ts): due a day or more after first use (a release build) until stamped; a claim
 * stamps it once; the same page's key is shown it again; any other claim after the stamp gets no.
 */
import { describe, expect, test } from "bun:test";
import { bandTipClaim, bandTipDue, bandTipUsed } from "./band-tip";

const NOW = "2026-11-20T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

describe("the Group tip", () => {
  test("due a day after first use, not before; a dev build asks for no tenure", () => {
    expect(bandTipDue({ firstUseAt: ago(DAY + 1), tenure: true, saved: undefined }, NOW)).toBe(true);
    expect(bandTipDue({ firstUseAt: ago(DAY - 60_000), tenure: true, saved: undefined }, NOW)).toBe(false);
    expect(bandTipDue({ firstUseAt: null, tenure: true, saved: undefined }, NOW)).toBe(false);
    expect(bandTipDue({ firstUseAt: null, tenure: false, saved: undefined }, NOW)).toBe(true);
  });

  test("a claim stamps it once; the same key again is shown it without a write; another key gets no", () => {
    const state = { firstUseAt: ago(2 * DAY), tenure: true, saved: undefined };
    const first = bandTipClaim(state, "key-aaaaaaaa", NOW);
    expect(first).toEqual({ show: true, save: { shownAt: NOW, key: "key-aaaaaaaa" } });
    const after = { ...state, saved: first.save! };
    expect(bandTipDue(after, NOW)).toBe(false);
    expect(bandTipClaim(after, "key-aaaaaaaa", NOW)).toEqual({ show: true, save: null });
    expect(bandTipClaim(after, "key-bbbbbbbb", NOW)).toEqual({ show: false, save: null });
    expect(bandTipClaim(after, null, NOW)).toEqual({ show: false, save: null });
  });

  test("a band's menu opened retires it whatever the tenure: on the first day it is stamped too, so it never shows; stamped once", () => {
    const firstDay = { firstUseAt: ago(60_000), tenure: true, saved: undefined };
    expect(bandTipDue(firstDay, NOW)).toBe(false);
    const save = bandTipUsed(firstDay, NOW);
    expect(save).toEqual({ shownAt: NOW, usedAt: NOW });
    // The next day: not due, and no claim shows it.
    const nextDay = NOW.replace("2026-11-20", "2026-11-21");
    const after = { ...firstDay, saved: save! };
    expect(bandTipDue(after, nextDay)).toBe(false);
    expect(bandTipClaim(after, "key-aaaaaaaa", nextDay)).toEqual({ show: false, save: null });
    // Already stamped (shown once): nothing to write.
    expect(bandTipUsed(after, nextDay)).toBeNull();
    expect(bandTipUsed({ ...firstDay, saved: { shownAt: NOW, key: "key-aaaaaaaa" } }, nextDay)).toBeNull();
  });
});
