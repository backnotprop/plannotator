import { describe, expect, test } from "bun:test";
import { launchTipClaim, launchTipDue, launchTipLaunched, type LaunchTipState } from "./launch-tip";

const AT = "2026-11-08T10:00:00.000Z";
const fresh: LaunchTipState = { owner: true, launched: false, saved: undefined };

describe("launchTipDue", () => {
  test("the owner, nothing started, never shown (whether To can start an agent is compose's check)", () => {
    expect(launchTipDue(fresh)).toBe(true);
  });
  test("never a guest, never once an agent was started here (its thread deleted too), never once shown", () => {
    expect(launchTipDue({ ...fresh, owner: false })).toBe(false);
    expect(launchTipDue({ ...fresh, launched: true })).toBe(false);
    expect(launchTipDue({ ...fresh, saved: { launchedAt: AT } })).toBe(false);
    expect(launchTipDue({ ...fresh, saved: { shownAt: AT } })).toBe(false);
    expect(launchTipDue({ ...fresh, saved: { key: "page-key-1" } })).toBe(true);
  });
});

describe("launchTipClaim", () => {
  test("the first claim shows it and stamps it with the page's key", () => {
    expect(launchTipClaim(fresh, "page-key-1", AT)).toEqual({ show: true, save: { shownAt: AT, key: "page-key-1" } });
    expect(launchTipClaim(fresh, null, AT)).toEqual({ show: true, save: { shownAt: AT } });
  });
  test("once stamped: the same key is shown it again with no write; any other claim gets no", () => {
    const stamped: LaunchTipState = { ...fresh, saved: { shownAt: AT, key: "page-key-1" } };
    expect(launchTipClaim(stamped, "page-key-1", "2026-11-08T10:00:02.000Z")).toEqual({ show: true, save: null });
    expect(launchTipClaim(stamped, "phone-key-2", AT)).toEqual({ show: false, save: null });
    expect(launchTipClaim(stamped, null, AT)).toEqual({ show: false, save: null });
  });
  test("a guest never claims it, even with the owner's key", () => {
    expect(launchTipClaim({ ...fresh, owner: false }, null, AT)).toEqual({ show: false, save: null });
    expect(launchTipClaim({ ...fresh, owner: false, saved: { shownAt: AT, key: "page-key-1" } }, "page-key-1", AT)).toEqual({ show: false, save: null });
  });
  test("an agent already started, or one whose thread was deleted since: no, and nothing written", () => {
    expect(launchTipClaim({ ...fresh, launched: true }, "page-key-1", AT)).toEqual({ show: false, save: null });
    expect(launchTipClaim({ ...fresh, saved: { launchedAt: AT } }, "page-key-1", AT)).toEqual({ show: false, save: null });
  });
});

describe("launchTipLaunched", () => {
  test("keeps the first time an agent was seen started, once; a stamp beside it stays", () => {
    expect(launchTipLaunched(undefined, AT)).toEqual({ launchedAt: AT });
    expect(launchTipLaunched({ shownAt: AT, key: "page-key-1" }, AT)).toEqual({ shownAt: AT, key: "page-key-1", launchedAt: AT });
    expect(launchTipLaunched({ launchedAt: AT }, "2026-11-09T00:00:00.000Z")).toBeNull();
  });
});
