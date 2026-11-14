/**
 * Every read, before and after: a store written through a record log answers every read the server makes
 * after a restart exactly as it did while it was being written.
 *
 * The failures this guards: a record log that loses or changes a record, a seq, an order, an archive line, a
 * PR event, a card's history or a deletion, so that after a restart a list row, a thread, an agent's pending
 * replies, the Board or Decision data reads differently.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { InboxStore } from "../store";
import { LOGS_UNDER_TEST } from "./logs-under-test";
import { everyRead } from "./reads";
import { writeInboxWorld } from "./world";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];

describe.each(LOGS_UNDER_TEST)("every read through the $name log", ({ name, log }) => {
  test(
    "a generated Inbox reads the same while written and after a restart",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const dataDir = mkdtempSync(join(tmpdir(), `plannotator-every-read-${name}-`));
          roots.push(dataDir);
          const world = writeInboxWorld({ dataDir, seed, steps: 220, log });
          const live = everyRead(world.store, { sessions: SESSIONS, bytes: true });
          const reference = everyRead(InboxStore.open(dataDir, { now: world.now, log }), { sessions: SESSIONS, bytes: true });
          // The world wrote something worth comparing: threads, questions, a Send, the Board.
          expect((reference.threads as unknown[]).length).toBeGreaterThan(10);
          expect(live).toEqual(reference);
        }),
        { numRuns: 4 },
      );
    },
    120_000,
  );
});
