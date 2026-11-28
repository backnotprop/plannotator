/**
 * The Mistral Vibe wake: the person's root, reply or tag for a Vibe session the Inbox launched goes into that
 * session as a turn, through its launch host (inbox-launch-vibe.ts, `deliver`).
 *
 * Vibe has no Plannotator plugin to poll the Inbox and no command that queues a message, so only a session this
 * Inbox launched (and so owns the `vibe-acp` of) is woken. A Vibe session the person started themselves keeps
 * reading its thread.
 *
 * Each item waiting for a launched session (`InboxStore.pendingRepliesFor`) is handed to the host once, in order. A
 * hand-off can take as long as the session's running turn (Vibe takes one prompt at a time), so each session's items
 * go in their own chain, and one busy session never holds up another's:
 *
 *  - every item is claimed on disk first (`inbox/vibe-deliver/<item id>.<session>/`, made with mkdir), so it is
 *    never handed twice, across restarts too; `delivered` is recorded at once and the claim goes;
 *  - `hold` (the session is stopped or deleted): the claim goes, and the item waits for the session to come back;
 *  - a failure is tried again later (30 s, doubling to 10 min), and the session's later items wait for it;
 *  - `uncertain` (it may have gone): kept claimed, never handed again, and the window says it is saved for the
 *    agent's next read.
 *
 * A sweep runs only when it can find something: a store line, a retry coming due, and once at start.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INBOX_VIBE_HOST, isInboxSessionId, type InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { codexWakeText } from "./inbox-codex-wake";
import type { LaunchDelivery } from "./inbox-launch-host";

const CLAIM_DIR = "vibe-deliver";
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export interface InboxVibeWake {
  /** Whether a message from this host and session wakes it: a launched Vibe session of this Inbox. */
  wakes(host: unknown, session: unknown): boolean;
  /** `alive` for a launched Vibe session the Inbox wakes; null otherwise. */
  status(session: string): "alive" | null;
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  sweep(): Promise<void>;
  stop(): void;
}

export function createInboxVibeWake(options: {
  store: InboxStore;
  /** The wake command for an item and the session it goes to (the bridge's `replyCommand`). */
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** The launch engine's `deliver` for a Vibe session. */
  deliver: (session: string, text: string) => Promise<LaunchDelivery>;
  /** The Inbox ids of every launched Vibe session that is not deleted. */
  launched: () => ReadonlySet<string>;
  /** An item not to hand at all (a steps-only Tidy wake once steps are off). */
  skip?: (item: InboxMessage, session: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}): InboxVibeWake {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const dir = join(store.dir, CLAIM_DIR);
  let stopped = false;

  const claimDir = (itemId: string, session: string) => join(dir, `${itemId}.${session}`);
  /** Claims made and not yet done with: `<item id>.<session>`. One left from an earlier run may have gone: uncertain. */
  const claimed = new Set<string>();
  const uncertain = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      if (name.indexOf(".") <= 0) continue;
      claimed.add(name);
      uncertain.add(name);
    }
  } catch {
    // No claims yet.
  }
  const dropClaim = (itemId: string, session: string) => {
    const key = `${itemId}.${session}`;
    store.handover.giveBack(itemId, session);
    claimed.delete(key);
    uncertain.delete(key);
    rmSync(claimDir(itemId, session), { recursive: true, force: true });
  };

  /** Whether the item goes to `session`: addressed to it (its owner), or a waking tag of it. */
  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (store.isOwner(item, session)) return !item.to || item.to.host === INBOX_VIBE_HOST;
    return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_VIBE_HOST && tag.wakes) ?? false;
  };

  /** Sessions whose chain is handing items now. */
  const chains = new Set<string>();
  const retryAt = new Map<string, { at: number; wait: number }>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (retryAt.size === 0 || stopped) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  /** Whether the item went (the session's next item may follow). */
  const handOne = async (item: InboxMessage, session: string): Promise<boolean> => {
    const id = store.deliveryIdOf(item, session);
    const key = `${id}.${session}`;
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return false;
    if (id === item.id && !store.handover.hand(item, session, INBOX_VIBE_HOST)) return false;
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(claimDir(id, session));
    } catch {
      claimed.add(key);
      return false;
    }
    claimed.add(key);
    const result = await options.deliver(session, codexWakeText(options.commandOf(item, session))).catch((error: unknown): LaunchDelivery => ({ failed: error instanceof Error ? error.message : String(error) }));
    if (result === "delivered") {
      retryAt.delete(key);
      try {
        store.recordDelivery(id, { host: INBOX_VIBE_HOST, session });
      } catch {
        // Gone, or no longer this session's.
      }
      dropClaim(id, session);
      return true;
    }
    if (result === "hold" || result === "queue") {
      // Not now: it waits in the Inbox, looked at again when the next line lands.
      retryAt.delete(key);
      dropClaim(id, session);
      return false;
    }
    if ("uncertain" in result) {
      retryAt.delete(key);
      uncertain.add(key);
      log(`the Vibe launch may have delivered ${item.id} to ${session} (${result.uncertain}); it is not sent again: the agent sees it when it reads the thread.`);
      return false;
    }
    dropClaim(id, session);
    const wait = Math.min((retry?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
    log(`the Vibe launch could not deliver ${item.id} to ${session}: ${result.failed}. Trying again later.`);
    return false;
  };

  const sweepOnce = async (): Promise<void> => {
    const sessions = new Set([...options.launched()].filter((session) => isInboxSessionId(session)));
    if (sessions.size === 0 && claimed.size === 0) return;
    const pending = sessions.size > 0 ? store.pendingRepliesFor(sessions, { tags: true }) : new Map<string, InboxMessage[]>();
    const pendingKeys = new Set<string>();
    const work: { item: InboxMessage; session: string }[] = [];
    for (const [session, items] of pending) {
      for (const item of items) {
        if (!wakesItem(item, session) || options.skip?.(item, session)) continue;
        const key = `${store.deliveryIdOf(item, session)}.${session}`;
        pendingKeys.add(key);
        if (!claimed.has(key)) work.push({ item, session });
      }
    }
    // A claim whose item no longer waits (delivered, read, deleted) is done with.
    for (const key of [...claimed]) {
      if (pendingKeys.has(key)) continue;
      const dot = key.indexOf(".");
      dropClaim(key.slice(0, dot), key.slice(dot + 1));
    }
    for (const key of [...retryAt.keys()]) if (!pendingKeys.has(key)) retryAt.delete(key);
    // In order within a session: once an item does not go, that session's later ones wait for it.
    const bySession = new Map<string, InboxMessage[]>();
    for (const { item, session } of work) if (!chains.has(session)) (bySession.get(session) ?? bySession.set(session, []).get(session)!).push(item);
    for (const [session, items] of bySession) {
      chains.add(session);
      void (async () => {
        let went = false;
        try {
          for (const item of items) {
            if (stopped || !(await handOne(item, session))) break;
            went = true;
          }
        } finally {
          chains.delete(session);
          scheduleRetry();
          // Items that came meanwhile; only after progress, so a held session is not asked again in a loop.
          if (went) void sweep();
        }
      })();
    }
    scheduleRetry();
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopped);
      } catch (error) {
        log(`the Vibe wake failed a sweep: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  let sweepQueued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message" || sweepQueued) return;
    if (options.launched().size === 0 && claimed.size === 0) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  // The first look: items left from before a restart.
  void sweep();

  return {
    wakes: (host, session) => host === INBOX_VIBE_HOST && typeof session === "string" && options.launched().has(session),
    status: (session) => (options.launched().has(session) ? "alive" : null),
    uncertain: (session, itemId) => uncertain.has(`${itemId}.${session}`),
    uncertainItems: (session) => [...uncertain].filter((key) => key.endsWith(`.${session}`)).map((key) => key.slice(0, key.indexOf("."))),
    sweep,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    },
  };
}
