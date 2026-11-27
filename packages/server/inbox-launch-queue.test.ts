/**
 * The launch dialog's place in the Inbox's line (inbox-launch-queue.ts), on the real launch switch with a temp data
 * folder and a fetch that never reaches the network. No Inbox is started.
 *
 * What regresses: the line of one-time dialogs frozen until the launch's end (up to 14 days) by a page whose claim came
 * back late or no, or by a data folder where the stamp cannot be written; the page no longer told to claim it after
 * the line moved on; a page left open not told when a kept launch starts; the launch drawn before, or over, the welcome
 * to the code review Inbox.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_SWITCH_FILE, createLaunchSwitch, type LaunchShownRecord, type LaunchShownStore } from "@plannotator/shared/launch-switch";
import { createInboxLaunchQueue } from "./inbox-launch-queue";

const START = Date.parse("2026-12-02T08:00:00Z");
const DOC = {
  v: 1,
  campaign: "product-hunt-2026",
  on: true,
  url: "https://www.producthunt.com/posts/plannotator",
  startsAt: "2026-12-02T08:00:00Z",
  endsAt: "2026-12-03T08:00:00Z",
};
const offline = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

function setup(store?: Partial<LaunchShownStore>, at = START + 1000, after?: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-launch-queue-"));
  writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(at).toISOString(), doc: DOC }));
  const records = new Map<string, LaunchShownRecord>();
  const shown: LaunchShownStore = {
    read: (c) => records.get(c),
    write: (c, r) => (records.set(c, r), true),
    stamp: (c, r) => (records.get(c)?.shownAt ? "taken" : (records.set(c, r), "stamped")),
    ...store,
  };
  let now = at;
  const service = createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/launch.json", shown, fetch: offline, now: () => now });
  return { queue: createInboxLaunchQueue(service, () => dir, after), records, setNow: (t: number) => (now = t) };
}

describe("the launch dialog in the Inbox's line", () => {
  test("after the welcome to the code review Inbox: while that waits, the launch is not due and holds nothing; then it is next", () => {
    let welcomeWaits = true;
    const { queue } = setup(undefined, START + 1000, () => welcomeWaits);
    expect([queue.due(), queue.holdsLine()]).toEqual([false, false]);
    welcomeWaits = false;
    expect([queue.due(), queue.holdsLine()]).toEqual([true, true]);
  });

  test("it holds the line until a claim is answered; the page is still told to claim it after that", () => {
    const { queue } = setup();
    expect([queue.due(), queue.holdsLine()]).toEqual([true, true]);
    expect(queue.action("claim", {}).body).toMatchObject({ show: true });
    expect([queue.due(), queue.holdsLine()]).toEqual([true, false]);
  });

  test("a claim that says no (another surface showed it meanwhile) releases the line", () => {
    const { queue, records } = setup();
    expect(queue.holdsLine()).toBe(true);
    records.set("product-hunt-2026", { shownAt: new Date(START).toISOString() });
    expect(queue.action("claim", {}).body).toEqual({ show: false });
    records.clear();
    expect(queue.holdsLine()).toBe(false);
  });

  test("a stamp that cannot be written: shown for this process, nothing held, nothing claimed again", () => {
    const { queue } = setup({ stamp: () => "failed", write: () => false });
    expect(queue.action("shown", { campaign: "product-hunt-2026" }).body).toEqual({ show: true });
    expect([queue.due(), queue.holdsLine()]).toEqual([false, false]);
  });

  test("a kept launch that starts later: nothing due yet, and the time until it starts", () => {
    const { queue, setNow } = setup(undefined, START - 2 * 3600_000);
    expect([queue.due(), queue.holdsLine()]).toEqual([false, false]);
    expect(queue.startsIn(START - 2 * 3600_000)).toBe(2 * 3600_000);
    setNow(START);
    expect([queue.due(), queue.holdsLine()]).toEqual([true, true]);
    expect(queue.startsIn(START)).toBeNull();
  });
});
