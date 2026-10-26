/**
 * `pendingRepliesFor` (the Codex wake's one pass over the messages) answers
 * exactly what `pendingReplies` answers for each session, and stays one pass:
 * 800 Codex threads with 32,000 messages, measured.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-pending-for-"));
  roots.push(dir);
  return InboxStore.open(dir);
}

const agent = (session: string, host = "codex"): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: null });
const thread = (i: number) => `019a2b3c-4d5e-7f00-8a9b-${String(i).padStart(12, "0")}`;

test("for every session, the same items in the same order as pendingReplies: replies, read ones, addressed messages, tags", () => {
  const store = open();
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const sessions = [thread(1), thread(2), thread(3), "ses_claude"];
  const asked = sessions.map((session) => store.sendMessage({ project_id: project.id, author: agent(session, session === "ses_claude" ? "claude-code" : "codex"), body: "Q?", wakes: true }).message);
  store.sendReply(asked[0]!.id, { words: "one", idempotency_key: "r1" });
  store.sendReply(asked[0]!.id, { words: "two", idempotency_key: "r2" });
  store.sendReply(asked[1]!.id, { words: "read", idempotency_key: "r3" });
  // An agent read thread 2: its reply no longer waits.
  store.markAgentChecked(asked[1]!.thread_id);
  store.sendReply(asked[3]!.id, { words: "tagging", idempotency_key: "r4", tags: [{ host: "codex", session: thread(3), wakes: true }] });
  const set = new Set(sessions);
  const all = store.pendingRepliesFor(set, { tags: true });
  for (const session of sessions) {
    expect((all.get(session) ?? []).map((m) => m.id)).toEqual(store.pendingReplies(session, { tags: true }).map((m) => m.id));
  }
  expect(all.get(thread(1))?.length).toBe(2);
  expect(all.has(thread(2))).toBe(false);
  expect(all.get(thread(3))?.length).toBe(1);
  // A session not asked about is not looked at.
  expect(store.pendingRepliesFor(new Set([thread(1)])).has(thread(3))).toBe(false);
  expect(store.pendingRepliesFor(new Set()).size).toBe(0);
});

test("one pass: 800 threads and 32,000 messages answer in well under the per-session cost", () => {
  const store = open();
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const sessions = new Set<string>();
  for (let i = 0; i < 800; i++) {
    const session = thread(i);
    sessions.add(session);
    for (let j = 0; j < 20; j++) {
      const asked = store.sendMessage({ project_id: project.id, author: agent(session), body: `Q${j}?`, thread: `t${i}`, wakes: true }).message;
      store.sendReply(asked.id, { words: `A${j}`, idempotency_key: `r${i}-${j}` });
    }
  }
  const started = performance.now();
  const all = store.pendingRepliesFor(sessions, { tags: true });
  const took = performance.now() - started;
  expect([...all.values()].reduce((n, items) => n + items.length, 0)).toBe(16_000);
  // Measured at about 12 ms on an M-series laptop; one pendingReplies per session took about 2 s for the 800.
  expect(took).toBeLessThan(400);
}, 120_000);
