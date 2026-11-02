/**
 * The Snooze announcement's rules (approval "inbox-snooze-announce"). What regresses: the two-day line moving (the
 * owner changed it from seven), an active-days rule coming back, a used or shown mark not ending it, a dev build
 * deciding it, the phone switch letting a guest in or a phone in while off, first use read from the wrong end of the
 * log, and a row counting as "read and left" when it is unread, typed in, snoozed, fresh, Sent or Quiet.
 */
import { describe, expect, test } from "bun:test";
import type { InboxListRow } from "./inbox-types";
import {
  SNOOZE_INTRO_TENURE_MS,
  snoozeIntroDue,
  snoozeIntroFirstUse,
  snoozeIntroNeed,
  snoozeIntroPageMay,
  snoozeIntroReadAndLeft,
  snoozeIntroWaits,
} from "./inbox-snooze-intro";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("snoozeIntroDue", () => {
  test("the two-day boundary: due at exactly 48 h of tenure, not a millisecond before", () => {
    expect(SNOOZE_INTRO_TENURE_MS).toBe(2 * DAY);
    expect(snoozeIntroDue({ firstUseAt: ago(2 * DAY) }, NOW, true)).toBe(true);
    expect(snoozeIntroDue({ firstUseAt: ago(2 * DAY - 1) }, NOW, true)).toBe(false);
    // No active-days rule: one use two days ago is enough.
    expect(snoozeIntroDue({ firstUseAt: ago(90 * DAY) }, NOW, true)).toBe(true);
  });

  test("each condition alone stops it", () => {
    const first = ago(3 * DAY);
    expect(snoozeIntroDue({ firstUseAt: first }, NOW, false)).toBe(false);
    expect(snoozeIntroDue({ firstUseAt: first, snoozedAt: ago(DAY) }, NOW, true)).toBe(false);
    expect(snoozeIntroDue({ firstUseAt: first, shownAt: ago(DAY) }, NOW, true)).toBe(false);
    expect(snoozeIntroDue({}, NOW, true)).toBe(false);
    expect(snoozeIntroDue(undefined, NOW, true)).toBe(false);
    expect(snoozeIntroDue({ firstUseAt: "not a date" }, NOW, true)).toBe(false);
    // A first use in the future (a clock moved back) is no tenure.
    expect(snoozeIntroDue({ firstUseAt: new Date(NOW.getTime() + DAY).toISOString() }, NOW, true)).toBe(false);
  });
});

describe("snoozeIntroPageMay: the phone switch", () => {
  test("off: this computer only; on: the owner's phone too; a guest never", () => {
    expect(snoozeIntroPageMay({ local: true, owner: true }, false)).toBe(true);
    expect(snoozeIntroPageMay({ local: false, owner: true }, false)).toBe(false);
    expect(snoozeIntroPageMay({ local: false, owner: false }, false)).toBe(false);
    expect(snoozeIntroPageMay({ local: false, owner: true }, true)).toBe(true);
    expect(snoozeIntroPageMay({ local: false, owner: false }, true)).toBe(false);
  });

  test("the switch is off by default (owner question q-e29f8cd6 open)", () => {
    expect(snoozeIntroPageMay({ local: false, owner: true })).toBe(false);
  });
});

describe("snoozeIntroFirstUse", () => {
  test("the oldest time of any line or record, wherever it is in the log", () => {
    const lines = [
      { at: ago(DAY), record: { created_at: ago(DAY) } },
      // A record rewritten later keeps when it was made.
      { at: ago(HOUR), record: { created_at: ago(5 * DAY) } },
      { at: ago(3 * DAY), record: {} },
    ];
    expect(snoozeIntroFirstUse(lines)).toBe(ago(5 * DAY));
    expect(snoozeIntroFirstUse([])).toBeNull();
  });
});

function row(over: Partial<InboxListRow>): InboxListRow {
  return {
    thread_id: "msg_a",
    section: "waiting",
    waiting_on_person: true,
    unseen: 0,
    unsent: null,
    snoozed: null,
    last_agent_at: ago(2 * DAY),
    last_at: ago(2 * DAY),
    ...over,
  } as InboxListRow;
}

describe("read and left", () => {
  test("a looked-at row waiting a day or more counts; anything else does not", () => {
    expect(snoozeIntroReadAndLeft(row({}), NOW)).toBe(true);
    expect(snoozeIntroReadAndLeft(row({ section: "new", waiting_on_person: false }), NOW)).toBe(true);
    expect(snoozeIntroReadAndLeft(row({ last_agent_at: ago(DAY) }), NOW)).toBe(true);
    expect(snoozeIntroReadAndLeft(row({ last_agent_at: ago(DAY - 1) }), NOW)).toBe(false);
    expect(snoozeIntroReadAndLeft(row({ unseen: 1 }), NOW)).toBe(false);
    expect(snoozeIntroReadAndLeft(row({ unsent: { reply_at: ago(HOUR), picks: 0, comments: 0 } as never }), NOW)).toBe(false);
    expect(snoozeIntroReadAndLeft(row({ snoozed: { until: ago(-DAY), at: ago(HOUR) } }), NOW)).toBe(false);
    expect(snoozeIntroReadAndLeft(row({ section: "sent" }), NOW)).toBe(false);
    expect(snoozeIntroReadAndLeft(row({ section: "quiet" }), NOW)).toBe(false);
  });

  test("the need: two read-and-left rows, not one", () => {
    expect(snoozeIntroNeed([row({}), row({ thread_id: "msg_b", unseen: 2 })], NOW)).toBe(false);
    expect(snoozeIntroNeed([row({}), row({ thread_id: "msg_b" })], NOW)).toBe(true);
  });

  test("waits on the person: the waiting sections or the flag, never a snoozed row", () => {
    expect(snoozeIntroWaits(row({ section: "stopped", waiting_on_person: false }))).toBe(true);
    expect(snoozeIntroWaits(row({ section: "new", waiting_on_person: true }))).toBe(true);
    expect(snoozeIntroWaits(row({ section: "sent", waiting_on_person: false }))).toBe(false);
    expect(snoozeIntroWaits(row({ snoozed: { until: ago(-DAY), at: ago(HOUR) } }))).toBe(false);
  });
});
