/**
 * The Mistral Vibe wake against a stub `deliver` (no Vibe, no launch engine). What each test guards: an item goes to
 * its launched session once and is recorded delivered; a failed hand-off is not asked again at once and holds up that
 * session's later items; one session waiting on a long turn never holds up another; a claim left by an earlier run is
 * never handed again (it may have gone); `hold` leaves the item for a later look.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { LaunchDelivery } from "./inbox-launch-host";
import { createInboxVibeWake } from "./inbox-vibe-wake";

const A = "7c2d9e10-4b3a-4f6e-8d21-0a1b2c3d4e5f";
const B = "0b6f3c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(10);
  }
}

function setup(deliver: (session: string, text: string) => Promise<LaunchDelivery>, options: { claims?: (dir: string) => void } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-vibe-wake-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = InboxStore.open(dataDir);
  options.claims?.(store.dir);
  const project = store.ensureProject({ name: "p", root: dataDir });
  const calls: { session: string; text: string }[] = [];
  const wake = createInboxVibeWake({
    store,
    commandOf: (item) => ({ type: "message", id: item.id, thread_id: item.thread_id, reply_to: null, subject: null, body: item.body, url: "http://127.0.0.1/" }),
    deliver: (session, text) => {
      calls.push({ session, text });
      return deliver(session, text);
    },
    launched: () => new Set([A, B]),
    log: () => {},
  });
  cleanup.push(() => wake.stop());
  const send = (session: string, body: string) => store.startPersonThread({ project_id: project.id, body, to: { host: "mistral-vibe", session }, idempotency_key: `k-${body}` }).message;
  return { store, wake, calls, send };
}

describe("the Mistral Vibe wake", () => {
  test("an item goes to its launched session once and is recorded delivered", async () => {
    const t = setup(async () => "delivered");
    const item = t.send(A, "Tidy the readme.");
    await until("delivered", () => t.store.message(item.id)!.delivery);
    expect(t.store.message(item.id)!.delivery).toMatchObject({ host: "mistral-vibe", session: A });
    await t.wake.sweep();
    expect(t.calls.filter((call) => call.text.includes("Tidy the readme."))).toHaveLength(1);
  });

  test("a failed hand-off is not asked again at once, and the session's later items wait for it", async () => {
    const t = setup(async () => ({ failed: "boom" }));
    const first = t.send(A, "First.");
    await until("tried", () => t.calls.length === 1);
    t.send(A, "Second.");
    await t.wake.sweep();
    await Bun.sleep(50);
    expect(t.calls.map((call) => call.text.includes("First."))).toEqual([true]);
    expect(t.store.message(first.id)!.delivery ?? null).toBeNull();
  });

  test("a session waiting on a long turn never holds up another session's item", async () => {
    let release!: () => void;
    const t = setup((session) => (session === A ? new Promise<LaunchDelivery>((done) => (release = () => done("delivered"))) : Promise.resolve("delivered")));
    const slow = t.send(A, "For A.");
    await until("A asked", () => t.calls.some((call) => call.session === A));
    const quick = t.send(B, "For B.");
    await until("B delivered while A waits", () => t.store.message(quick.id)!.delivery);
    expect(t.store.message(slow.id)!.delivery ?? null).toBeNull();
    release();
    await until("A delivered", () => t.store.message(slow.id)!.delivery);
  });

  test("hold leaves the item waiting, asked again at the next look", async () => {
    let answer: LaunchDelivery = "hold";
    const t = setup(async () => answer);
    const item = t.send(A, "Later.");
    await until("held once", () => t.calls.length === 1);
    expect(t.store.message(item.id)!.delivery ?? null).toBeNull();
    answer = "delivered";
    await t.wake.sweep();
    await until("delivered", () => t.store.message(item.id)!.delivery);
  });

  test("a claim an earlier run left is never handed again (it may have gone)", async () => {
    let claimDir = "";
    const t = setup(async () => "delivered", { claims: (dir) => (claimDir = dir) });
    // The item exists first, then the claim an interrupted run would have made for it, then a fresh wake.
    t.wake.stop();
    const item = t.send(A, "Maybe sent.");
    mkdirSync(join(claimDir, "vibe-deliver", `${item.id}.${A}`), { recursive: true });
    const calls: string[] = [];
    const again = createInboxVibeWake({
      store: t.store,
      commandOf: (m) => ({ type: "message", id: m.id, thread_id: m.thread_id, reply_to: null, subject: null, body: m.body, url: "http://127.0.0.1/" }),
      deliver: async (session) => {
        calls.push(session);
        return "delivered";
      },
      launched: () => new Set([A]),
      log: () => {},
    });
    cleanup.push(() => again.stop());
    await again.sweep();
    expect(calls).toEqual([]);
    expect(again.uncertain(A, item.id)).toBe(true);
  });
});
