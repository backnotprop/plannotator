/**
 * The window's half of the Snooze announcement's rules (approval "inbox-snooze-announce"). What regresses: a row
 * counting as "read and left" when it is unread, typed in, snoozed, fresh, Sent or Quiet; one such row being enough;
 * a snoozed or Sent thread counting as waiting on the person.
 */
import { describe, expect, test } from "bun:test";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { snoozeIntroNeed, snoozeIntroReadAndLeft, snoozeIntroWaits } from "./snoozeIntroRows";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
