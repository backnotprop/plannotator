/**
 * What the Codex wake keeps on disk for steering (inbox-codex-wake.ts), only with the experimental `codex-steer` switch:
 *
 *  - `codex-queue/steer-on`: written at start with the switch on. An Inbox that starts with the switch off and sees it
 *    in the claims folder (which it lists at start anyway) clears what an earlier run left: every held file (so the
 *    hook can never take a reply the agent read meanwhile, nor start the binary on every tool call), the `next-turn`
 *    records, and the mark itself. Never on: nothing of it exists, and nothing is done.
 *  - `codex-queue/next-turn/<item id>.<thread id>`: a reply that goes only as the next turn from now on (it was
 *    steered once, or a turn ended without it). Written before the steer, so a reply is steered at most once, across
 *    a restart too.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearCodexHookHolds, CODEX_NEXT_TURN_DIR, CODEX_QUEUE_DIR, CODEX_STEER_ON_FILE } from "@plannotator/shared/inbox/codex-hook-mailbox";

const KEY = /^[A-Za-z0-9_-]{1,128}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The switch on at start: the mark written. */
export function markCodexSteerOn(inboxDir: string): void {
  const queue = join(inboxDir, CODEX_QUEUE_DIR);
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, CODEX_STEER_ON_FILE), "", { mode: 0o600 });
}

/** The switch off at start, and an earlier run had it on (its mark): what it left is cleared, once. */
export function clearCodexSteerLeftovers(inboxDir: string): void {
  const queue = join(inboxDir, CODEX_QUEUE_DIR);
  clearCodexHookHolds(inboxDir, new Set());
  rmSync(join(queue, CODEX_NEXT_TURN_DIR), { recursive: true, force: true });
  rmSync(join(queue, CODEX_STEER_ON_FILE), { force: true });
}

/** The replies that go only as the next turn, kept on disk (claim keys `<item id>.<thread id>`). */
export interface CodexNextTurnOnly extends Iterable<string> {
  has(key: string): boolean;
  add(key: string): void;
  delete(key: string): void;
}

/** `durable` false (the switch off): memory only, nothing read or written. */
export function codexNextTurnOnly(inboxDir: string, durable: boolean): CodexNextTurnOnly {
  const dir = join(inboxDir, CODEX_QUEUE_DIR, CODEX_NEXT_TURN_DIR);
  const keys = new Set<string>();
  if (durable) {
    try {
      for (const name of readdirSync(dir)) if (KEY.test(name)) keys.add(name);
    } catch {
      // None yet.
    }
  }
  return {
    has: (key) => keys.has(key),
    add(key) {
      if (keys.has(key)) return;
      keys.add(key);
      if (!durable || !KEY.test(key)) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, key), "", { mode: 0o600 });
    },
    delete(key) {
      if (!keys.delete(key) || !durable) return;
      rmSync(join(dir, key), { force: true });
    },
    [Symbol.iterator]: () => keys.values(),
  };
}
