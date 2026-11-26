/**
 * Ship's notes and a cloud agent (inbox-cloud-wake.ts): the stop and closed lines never start a run (a run started only
 * to be told to stop would act on the pull request), while an update note wakes a shipping cloud agent as any reply
 * would. The cloud wake over a real store in a temp data dir, with a fake webhook (no network).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxCloudWake, type InboxCloudWaker } from "./inbox-cloud-wake";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const CLOUD = "cloud.0123456789ab";

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function world() {
  const store = InboxStore.open(join(mkdtempSync(join(tmpdir(), "plannotator-cloud-wake-ship-")), "data"));
  const project = store.ensureProject({ name: "fern-api", root: "/tmp/fern-api" });
  const cloudAuthor: InboxAuthor = { kind: "agent", host: "cloud", session: CLOUD, name: "Night bot" };
  const thread = store.sendMessage({ project_id: project.id, author: cloudAuthor, subject: "Send a receipt after checkout", body: "Shipping #614." }).message;
  const agent: InboxCloudAgent = {
    session: CLOUD,
    name: "Night bot",
    preset: "other",
    url: "https://hooks.example.invalid/wake",
    key: "test-key",
    project_id: project.id,
    created_at: "2026-11-24T00:00:00.000Z",
    key_set_at: "2026-11-24T00:00:00.000Z",
    key_rejected_at: null,
  };
  const agents = { list: () => [agent], agent: (session: string) => (session === CLOUD ? agent : null), homeRoot: () => null, markKeyRejected: () => {} } as unknown as InboxCloudAgents;
  const posted: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    posted.push(init.body);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const wake: InboxCloudWaker = createInboxCloudWake({ store, agents, pin: () => {}, threadUrl: (id) => `http://127.0.0.1:1/#thread=${id}`, fetch: fakeFetch, gapMs: 0, log: () => {} });
  stops.push(() => wake.stop());
  const tell = (body: string, kind: "watch" | "stop") => store.tellShip(thread.id, { body, to: { host: "cloud", session: CLOUD }, ship_note: { ship: "shp_1", kind } })!;
  return { store, wake, posted, tell };
}

test("Ship's stop line waiting for a cloud agent starts no run", async () => {
  const w = world();
  const note = w.tell("Stop shipping #614. Don't push or merge it; leave it as it is.", "stop");
  expect(w.store.pendingReplies(CLOUD).map((m) => m.id)).toContain(note.id);
  await w.wake.sweep();
  await Bun.sleep(30);
  expect(w.posted).toEqual([]);
  expect(w.store.message(note.id)!.cloud_wake ?? null).toBeNull();
});

test("Ship's update note wakes a shipping cloud agent", async () => {
  const w = world();
  w.tell("Checks failed on aaaaaaa: lint. Fix them and push.\nYou are still shipping #614.", "watch");
  await w.wake.sweep();
  await until(() => w.posted.length === 1);
  expect(w.posted[0]).toContain("Checks failed on aaaaaaa: lint.");
});
