/**
 * Start in T3 Code beside Start in Rex (Settings → Agents' "Start new agents in"): one place at a time. The failures
 * this guards: with T3 Code chosen, Rex asked for a tab too (a second agent beside the T3 thread), or the launch
 * marked as Rex's; with Rex chosen, a T3 thread started too.
 *
 * The launch engine against the T3 stand-in (tests/helpers/fake-t3.ts) and a stand-in for Rex's `open`, the agents'
 * own hosts standing in (tests/helpers/t3-launch.ts). No Inbox server, no Rex and no T3 run.
 */
import { afterEach, expect, test } from "bun:test";
import { t3LaunchSetup, until } from "../../tests/helpers/t3-launch";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

const USED = [{ threadId: "thread:project:p:1", title: "Totals", providerInstanceId: "claudeAgent", model: "opus" }];

test("T3 Code chosen, with Rex here: the agent starts as a T3 thread, Rex is never asked, and the launch is not Rex's", async () => {
  const t = t3LaunchSetup(cleanup, { startIn: "t3", rex: true, used: USED });
  const root = await t.send("Tighten the checkout copy.");
  expect(root.launch!.rex).toBeUndefined();
  const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
  expect(t.rexOpens).toEqual([]);
  expect(t.t3!.starts().map((s) => s.id)).toEqual([session]);
  expect(t.store.message(root.id)!.launch).toMatchObject({ t3: {}, inner: { model: "opus" } });
});

test("Rex chosen, with T3 Code here: nothing asks T3, and the launch is not T3's", async () => {
  const t = t3LaunchSetup(cleanup, { startIn: "rex", rex: true, used: USED });
  const root = await t.prepare("Tighten the checkout copy.");
  expect(root.launch!.t3).toBeUndefined();
  expect(t.t3!.calls()).toEqual([]);
});
