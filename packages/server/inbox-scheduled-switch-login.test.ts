/**
 * Routines' switch and its login item (inbox-scheduled-routes.ts `scheduledSwitch`), on a stand-in login item (never
 * this computer's launchd or systemd). What regresses: two turns close together (a linked computer's flip turning
 * Routines on as the person turns them off here) running their login-item syncs at once, so an add that finishes after
 * the remove leaves a login item while Routines are off, or a remove that finishes late takes it away while they are on.
 */
import { expect, test } from "bun:test";
import type { InboxLoginItem } from "./inbox-scheduled-login";
import { scheduledSwitch } from "./inbox-scheduled-routes";

/** A switch whose login item's add and remove each wait until the test lets them finish. */
function world() {
  let saved: boolean | undefined;
  const item = { present: false, calls: [] as string[] };
  const waiting: (() => void)[] = [];
  const later = <T>(finish: () => T) => new Promise<T>((resolve) => waiting.push(() => resolve(finish())));
  const login: InboxLoginItem = {
    path: null,
    add: () => (item.calls.push("add"), later(() => ((item.present = true), "added" as const))),
    remove: () => (item.calls.push("remove"), later(() => void (item.present = false))),
  };
  const cap = scheduledSwitch({ platform: "darwin", saved: () => saved, save: (on) => void (saved = on), login, changed: () => {} });
  /** Lets every login-item call made so far finish, the latest first (the worst order). */
  const finish = async () => {
    for (let i = 0; i < 10; i++) {
      for (const done of waiting.splice(0).reverse()) done();
      await Bun.sleep(1);
    }
  };
  return { cap, item, finish };
}

test("Routines turned on then at once off: the add finishes first, then the remove, and no login item is left", async () => {
  const { cap, item, finish } = world();
  const turningOn = cap.answer({ scheduled_threads: { on: true } });
  await Bun.sleep(1);
  expect(item.calls).toEqual(["add"]);
  const turningOff = cap.answer({ scheduled_threads: { on: false } });
  await finish();
  await Promise.all([turningOn, turningOff]);
  expect([item.calls, item.present, cap.wire()]).toEqual([["add", "remove"], false, { scheduled_threads: { on: false } }]);
});

test("Routines turned off then at once on: the remove finishes first, then the add, and the login item is there", async () => {
  const { cap, item, finish } = world();
  await Promise.all([cap.answer({ scheduled_threads: { on: true } }), finish()]);
  const turningOff = cap.answer({ scheduled_threads: { on: false } });
  await Bun.sleep(1);
  const turningOn = cap.answer({ scheduled_threads: { on: true } });
  await finish();
  await Promise.all([turningOff, turningOn]);
  expect([item.calls, item.present, cap.wire()]).toEqual([["add", "remove", "add"], true, { scheduled_threads: { on: true, login: "added" } }]);
});
