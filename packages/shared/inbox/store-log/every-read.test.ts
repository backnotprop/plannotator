/** A store written through each record log answers every read the same while written, after a restart, and as the JSONL store does for the same writes. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { InboxStore } from "../store";
import { jsonlInboxLog } from "./jsonl-log";
import { LOGS_UNDER_TEST } from "./logs-under-test";
import { everyRead } from "./reads";
import { teeLog } from "./tee-log";
import { writeInboxWorld } from "./world";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];

describe.each(LOGS_UNDER_TEST)("every read through the $name log", ({ name, log }) => {
  test(
    "a generated Inbox reads the same while written, after a restart, and as today's JSONL store",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const dataDir = mkdtempSync(join(tmpdir(), `plannotator-every-read-${name}-`));
          roots.push(dataDir);
          const today = name === "jsonl";
          const world = writeInboxWorld({ dataDir, seed, steps: 220, log: today ? jsonlInboxLog : teeLog(jsonlInboxLog, log) });
          const live = everyRead(world.store, { sessions: SESSIONS, bytes: true });
          const reference = everyRead(InboxStore.open(dataDir, { now: world.now, log: jsonlInboxLog }), { sessions: SESSIONS, bytes: true });
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
