/**
 * The row's and the Board lane card's amber pause (approval "inbox-checklist-spinners-2026-11-07": "the still amber
 * pause only while the thread waits on the person"). What regresses: a row left amber after the person answered, or
 * amber for good once the session that would update the list has ended.
 */
import { describe, expect, test } from "bun:test";
import type { InboxSteps } from "@plannotator/core/inbox-types";
import { INBOX_STEPS_IDLE_MS, inboxStepsWaitOnPerson, type InboxStepsLive } from "./inbox-steps";

const now = Date.parse("2026-11-07T15:00:00.000Z");
const listAt = new Date(now - 5 * 60_000).toISOString();
const list = (status: "waiting" | "doing", updatedAt = listAt): InboxSteps => ({
  id: "stp_00000000000000000000000000",
  project_id: "prj_x",
  thread_id: "msg_x",
  agent: { kind: "agent", host: "claude-code", session: "ses_a", name: null },
  steps: [{ step: "Reproduce", status: "done", note: null, at: listAt }, { step: "Pick the backfill window", status, note: null, at: listAt }],
  updated_at: updatedAt,
});
const live = (connection: { busy: boolean | null } | null, ended = false): InboxStepsLive => ({
  deliveryConnectionOf: () => connection,
  lastHeardOf: () => now - 60_000,
  endedOf: () => ended,
});
const nobodyAnswered = () => false;

describe("a checklist still waits on the person", () => {
  test("a waiting step, the person silent since the list, the session there: waits", () => {
    expect(inboxStepsWaitOnPerson(list("waiting"), live({ busy: false }), now, nobodyAnswered)).toBe(true);
  });

  test("the person answered after the list: the flag is gone; the agent rewriting its list after that: it waits again", () => {
    // The person answered (a reply or a 👍) two minutes ago; the rule asks about each list's own last write.
    const answeredAt = now - 2 * 60_000;
    const asked: string[] = [];
    const answeredSince = (threadId: string, since: string) => {
      asked.push(threadId);
      return answeredAt >= Date.parse(since);
    };
    expect(inboxStepsWaitOnPerson(list("waiting"), live({ busy: false }), now, answeredSince)).toBe(false);
    expect(asked).toEqual(["msg_x"]);
    expect(inboxStepsWaitOnPerson(list("waiting", new Date(now - 60_000).toISOString()), live({ busy: false }), now, answeredSince)).toBe(true);
    // A tie counts as answered: never left amber on the same moment.
    expect(inboxStepsWaitOnPerson(list("waiting", new Date(answeredAt).toISOString()), live({ busy: false }), now, answeredSince)).toBe(false);
  });

  test("the session ended (seen gone, or unheard past the idle bar): the flag is gone", () => {
    expect(inboxStepsWaitOnPerson(list("waiting"), live(null, true), now, nobodyAnswered)).toBe(false);
    const quiet: InboxStepsLive = { deliveryConnectionOf: () => null, lastHeardOf: () => null, endedOf: () => false };
    expect(inboxStepsWaitOnPerson(list("waiting", new Date(now - INBOX_STEPS_IDLE_MS - 60_000).toISOString()), quiet, now, nobodyAnswered)).toBe(false);
  });

  test("no waiting step: never", () => {
    expect(inboxStepsWaitOnPerson(list("doing"), live({ busy: true }), now, nobodyAnswered)).toBe(false);
  });
});
