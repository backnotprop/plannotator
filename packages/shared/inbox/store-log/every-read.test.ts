/**
 * Every read, before and after: a store written through a record log answers every read the server makes
 * exactly as it did while it was being written, after a restart, and exactly as today's JSONL store answers
 * for the same writes.
 *
 * The failures this guards: a record log (today's JSONL, or the SQLite one that will replace it) that loses
 * or changes a record, a seq, an order, an archive line, a PR event, a card's history or a deletion, so that
 * after the move a list row, a thread, an agent's pending replies, the Board or Decision data reads
 * differently. A log under test is written beside today's JSONL in the same data dir (the same writes, the
 * same ids), then each is opened on its own and every read compared.
 *
 * While the world is written, every step also checks the list rows the store keeps per thread (store-row-cache.ts)
 * against every row built again from the store: the whole list, one project's, and single rows. The live sessions
 * move underneath the store between steps with no store call (a session ends or comes back, a connection turns busy,
 * an item's wait clock starts, the auto-send wait changes), and now and then the server hands in new ones. A row that
 * differs is a missed invalidation: a stale row in every window until the next restart.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { InboxStore, type InboxDeliveryPresence } from "../store";
import { inboxRowOrder } from "../store-row-cache";
import { jsonlInboxLog } from "./jsonl-log";
import { LOGS_UNDER_TEST } from "./logs-under-test";
import { everyRead } from "./reads";
import { teeLog } from "./tee-log";
import { seeded, writeInboxWorld } from "./world";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];

/** Live sessions that change underneath the store (the server's are a view of its connections, read on demand). */
function movingPresence(seed: number) {
  const random = seeded(seed ^ 0x5eed);
  const live = new Set(SESSIONS);
  const busy = new Set<string>();
  const waiting = new Map<string, { since: string; autoSince: string | null }>();
  let flags = 0;
  const made = (): InboxDeliveryPresence => ({
    connection: (session) => (live.has(session) ? { busy: busy.has(session), send_now: busy.has(session), ...(flags & 1 ? { held: true } : {}) } : null),
    askerLive: (session) => live.has(session),
    hostOf: (session) => (live.has(session) ? "claude-code" : null),
    launchResumes: (_thread, session) => (flags & 2) !== 0 && session === SESSIONS[2],
    uncertain: (_session, item) => (flags & 4) !== 0 && item.endsWith("1"),
    stuck: (_session, item) => (flags & 8) !== 0 && item.endsWith("2"),
    autoSendAfterMs: 60_000,
    waitOf: (session) => waiting.get(session) ?? null,
  });
  let presence = made();
  return {
    get presence() {
      return presence;
    },
    /** One step's move: mostly underneath the store; now and then new live sessions handed in (a store call). */
    move(store: InboxStore): void {
      const session = SESSIONS[Math.floor(random() * SESSIONS.length)]!;
      const roll = random();
      if (roll < 0.2) live.has(session) ? live.delete(session) : live.add(session);
      else if (roll < 0.4) busy.has(session) ? busy.delete(session) : busy.add(session);
      else if (roll < 0.55) waiting.has(session) ? waiting.delete(session) : waiting.set(session, { since: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(random() * 600))).toISOString(), autoSince: random() < 0.5 ? null : "2026-10-01T09:00:00.000Z" });
      else if (roll < 0.65) flags ^= 1 << Math.floor(random() * 4);
      else if (roll < 0.7) presence.autoSendAfterMs = random() < 0.5 ? 30_000 : 60_000;
      else if (roll < 0.73) store.setDeliveryPresence((presence = made()));
    },
  };
}

/** Every row built again from the store, past its row cache (the cache's private builder, in the list's order). */
function rebuilt(store: InboxStore, projectId?: string): InboxListRow[] {
  const inner = store as unknown as { listedThreadIds(): Iterable<string>; buildRow(threadId: string): InboxListRow | null };
  const rows: InboxListRow[] = [];
  for (const id of inner.listedThreadIds()) {
    const row = inner.buildRow(id);
    if (row && (!projectId || row.project.id === store.canonicalProjectId(projectId))) rows.push(row);
  }
  return rows.sort(inboxRowOrder);
}

/**
 * The kept rows equal rows built again: three single rows first (a row read asks only its own live-session calls
 * again, so it is checked before a list read asks them all), then the whole list and one project's.
 */
function rowCacheHolds(store: InboxStore, step: number, seed: number): void {
  const at = { seed, step };
  const threads = store.threadIds();
  const inner = store as unknown as { buildRow(threadId: string): InboxListRow | null };
  for (const id of [threads[step % Math.max(1, threads.length)], threads[(step * 7) % Math.max(1, threads.length)], threads.at(-1)]) {
    if (id) expect({ ...at, id, row: store.listRow(id) }).toEqual({ ...at, id, row: inner.buildRow(id) });
  }
  expect({ ...at, rows: store.listRows() }).toEqual({ ...at, rows: rebuilt(store) });
  const projects = store.allProjects();
  const project = projects[step % projects.length];
  if (project) expect({ ...at, project: project.id, rows: store.listRows({ projectId: project.id }) }).toEqual({ ...at, project: project.id, rows: rebuilt(store, project.id) });
}

describe.each(LOGS_UNDER_TEST)("every read through the $name log", ({ name, log }) => {
  test(
    "a generated Inbox reads the same while written, after a restart, and as today's JSONL store",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const dataDir = mkdtempSync(join(tmpdir(), `plannotator-every-read-${name}-`));
          roots.push(dataDir);
          const today = name === "jsonl";
          const moving = movingPresence(seed);
          let handedIn = false;
          const world = writeInboxWorld({
            dataDir,
            seed,
            steps: 220,
            log: today ? jsonlInboxLog : teeLog(jsonlInboxLog, log),
            afterStep: (store, step) => {
              if (!handedIn) store.setDeliveryPresence(moving.presence);
              handedIn = true;
              moving.move(store);
              rowCacheHolds(store, step, seed);
            },
          });
          // The reference store below has no live sessions.
          world.store.setDeliveryPresence(null);
          const live = everyRead(world.store, { sessions: SESSIONS, bytes: true });
          const reference = everyRead(InboxStore.open(dataDir, { now: world.now, log: jsonlInboxLog }), { sessions: SESSIONS, bytes: true });
          // The world wrote something worth comparing: threads, questions, a Send, the Board.
          expect((reference.threads as unknown[]).length).toBeGreaterThan(10);
          expect(live).toEqual(reference);
          if (today) return;
          const reopened = everyRead(InboxStore.open(dataDir, { now: world.now, log }), { sessions: SESSIONS, bytes: false });
          expect(reopened).toEqual(everyRead(InboxStore.open(dataDir, { now: world.now, log: jsonlInboxLog }), { sessions: SESSIONS, bytes: false }));
        }),
        { numRuns: 4 },
      );
    },
    120_000,
  );
});
