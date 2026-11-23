/**
 * Plannotator Inbox: when the person last did something in a thread (approval "inbox-recent-activity-filter"), what
 * the list filter's "Recent activity" keeps and sorts by. The list row's `acted_at` is the later of two sources:
 *
 * - The store's own records of the person (`personActOf*`, read by `InboxStore.personActedAt` as each line is
 *   applied, never a pass over the store): a message of theirs (a reply, answers sent, Done / Can't do it's report, a
 *   Re-ask, a review verdict, a new thread), a pick, an action item's Done / Can't do it / Skip, and a comment (an
 *   annotation saved, changed or removed), a 👍 Looks good (or a tray reaction) on an agent's message (its `ack.at`,
 *   from the window or the phone), and a guided review's reviewed ticks or a review's Viewed files changing (the
 *   line's time). Not the Inbox's own notes (Mark read's set-aside note, an Undo's reopened note, the note that carries
 *   a 👍 to the agent, Tidy's), and not a routine's run: none of those is the person doing something in the thread.
 * - `inbox/acted.json`, what the log does not hold: the person opening the thread (the window's opening look says
 *   `opened`), a film played in it, a reply or comment draft saved, a reply draft deleted, and a question asked in
 *   its Ask AI.
 *
 *   inbox/acted.json   { v: 1, threads: { <thread id>: <ISO time> } }, 0600, written whole (temp, then rename)
 *
 * Written at most once per `INBOX_ACTED_FLUSH_MS` (a draft saved as the person types is one write, not one per save),
 * keeping the newest `INBOX_ACTED_MAX` threads, none older than the filter reaches (`INBOX_RECENT_ACTIVITY_DAYS`), none
 * ahead of the clock (`INBOX_ACTED_FUTURE_MS`: a clock set back; never read either) and
 * none of a thread this store held and no longer does (deleted; `sweep`). A file from a newer Plannotator is never
 * written over (the notes hold in memory); one that does not read is moved aside first (`acted.json.unreadable-<time>`),
 * as pins.json is. The person's private view state, like pins: outside the event log (no
 * line, no seq, no event), never on anything an agent reads, and nothing else reads it: no section, unread, count,
 * delivery or order of the list moves for it. A thread id this store does not hold is kept (a linked machine's
 * thread opened in this window): the merged list reads it for that machine's rows.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_RECENT_ACTIVITY_DAYS, isInboxId, isInboxNote, type InboxAnnotationRecord, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";

export const INBOX_ACTED_FILE = "acted.json";
/** The threads the file keeps, newest first: far more than the list's last 30 days ever show. */
export const INBOX_ACTED_MAX = 2000;
/** How long a note waits for others before the file is written. */
export const INBOX_ACTED_FLUSH_MS = 2000;

/** The later of two ISO times (null: none). */
export function laterActed(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** A message the person wrote themselves: when; null for an agent's, the Inbox's own notes and a routine's run. */
export function personActOfMessage(message: InboxMessage): string | null {
  if (message.author.kind !== "person" || isInboxNote(message) || message.scheduled_run) return null;
  return message.created_at;
}

/**
 * A message's later line, the person's doing on it: their 👍 (`ack.at`: only the person's press sets an ack), and a
 * guided review's reviewed ticks or a review's Viewed files changed since `before` (only the person ticks them; the
 * line's `at`). Null for any other line.
 */
export function personActOfMessageLine(before: InboxMessage | undefined, after: InboxMessage, at: string): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const ticked = before !== undefined && (!same(before.guide_reviewed, after.guide_reviewed) || !same(before.guide_viewed, after.guide_viewed));
  return laterActed(after.ack?.at ?? null, ticked ? at : null);
}

/** A question record: the person's pick, or their Done / Can't do it / Skip on an action item; null when neither. */
export function personActOfQuestion(record: InboxQuestionRecord): string | null {
  const picked = record.picked_by?.id === "person" ? record.picked_at : null;
  const marked = record.action_result?.by === "person" ? record.action_result.at : null;
  return laterActed(picked, marked);
}

/** A comment (an annotation is always the person's): when it was saved, changed or removed last. */
export function personActOfAnnotation(record: InboxAnnotationRecord): string {
  return laterActed(laterActed(record.created_at, record.updated_at), record.removed_at)!;
}

/**
 * How far past the server's clock a kept time may be. More is a time from before the clock was set back (a clock
 * change, a machine's clock fixed): it is dropped, read or written, so it never holds its thread at the top of
 * "Recent activity" for as long as the clock takes to catch up.
 */
export const INBOX_ACTED_FUTURE_MS = 60_000;

/** The time is no later than `now` allows (`INBOX_ACTED_FUTURE_MS`). */
export function actedNotAhead(at: string, now: number): boolean {
  return Date.parse(at) <= now + INBOX_ACTED_FUTURE_MS;
}

/**
 * acted.json as a map; a file that does not read (or a newer version's) is none. `now` (the server's clock): a time
 * too far ahead of it is left out (`actedNotAhead`).
 */
export function readInboxActed(inboxDirPath: string, now?: number): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const value = JSON.parse(readFileSync(join(inboxDirPath, INBOX_ACTED_FILE), "utf8")) as { v?: unknown; threads?: unknown } | null;
    if (!value || typeof value !== "object" || value.v !== 1 || !value.threads || typeof value.threads !== "object") return out;
    for (const [id, at] of Object.entries(value.threads as Record<string, unknown>)) {
      if (!isInboxId("msg", id) || typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
      if (now === undefined || actedNotAhead(at, now)) out.set(id, at);
    }
  } catch {
    // Missing or unreadable: no notes yet.
  }
  return out;
}

/** What acted.json holds before a write (pins.ts `inboxPinsFileState`'s rule): a newer version's or a bad file reads as none. */
export function inboxActedFileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(join(inboxDirPath, INBOX_ACTED_FILE), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad";
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "bad";
  }
  const file = value as { v?: unknown; threads?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return "bad";
  if (typeof file.v === "number" && file.v > 1) return "newer";
  return file.v === 1 && !!file.threads && typeof file.threads === "object" ? "ok" : "bad";
}

/** Write the file whole; a newer version's file stays as it is (false), a bad one is moved aside first. */
function writeInboxActed(inboxDirPath: string, threads: ReadonlyMap<string, string>): boolean {
  const file = join(inboxDirPath, INBOX_ACTED_FILE);
  const state = inboxActedFileState(inboxDirPath);
  if (state === "newer") return false;
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, threads: Object.fromEntries(threads) })}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows: the mode is a no-op.
  }
  renameSync(temp, file);
  return true;
}

export interface InboxActed {
  /** The person did something in the thread now (or at `at`); a time older than the one kept changes nothing. */
  note(threadId: string, at?: string): void;
  /** When the file says the person last did something there, or null. */
  at(threadId: string): string | null;
  /** Write now what waits, if anything does (a server going away). */
  flush(): void;
  /** A deletion happened: the times of threads this store held and no longer does go at the next write. */
  sweep(): void;
}

const DAY_MS = 86_400_000;

/**
 * `held`: this store holds the thread (server: `store.thread(id) !== null`). A thread it never held (a linked
 * machine's, opened in this window) is kept until it ages out: only a thread seen held and then gone is a deletion.
 */
export function createInboxActed(inboxDirPath: string, options: { now?: () => Date; flushMs?: number; held?: (threadId: string) => boolean } = {}): InboxActed {
  const now = options.now ?? (() => new Date());
  const flushMs = options.flushMs ?? INBOX_ACTED_FLUSH_MS;
  const held = options.held ?? (() => false);
  let threads: Map<string, string> | null = null;
  /** The ids in `threads` this store held when last looked at: `sweep` drops those it no longer holds. */
  const own = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loaded = () => {
    if (threads) return threads;
    threads = readInboxActed(inboxDirPath, now().getTime());
    for (const id of threads.keys()) if (held(id)) own.add(id);
    return threads;
  };
  // Read at once: a deletion before the first note must know which of the file's threads this store held.
  loaded();
  /** What the file keeps: no deleted thread's time, none past the filter's reach or ahead of the clock, the newest `INBOX_ACTED_MAX`. */
  const pruned = (all: Map<string, string>): Map<string, string> => {
    const clock = now().getTime();
    const reach = clock - INBOX_RECENT_ACTIVITY_DAYS * DAY_MS;
    const kept = [...all].filter(([id, at]) => Date.parse(at) >= reach && actedNotAhead(at, clock) && !(own.has(id) && !held(id)));
    for (const id of own) if (!held(id)) own.delete(id);
    kept.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    return new Map(kept.slice(0, INBOX_ACTED_MAX));
  };
  /** A kept time, unless the clock went back past it since it was noted. */
  const fresh = (at: string | undefined): string | null => (at !== undefined && actedNotAhead(at, now().getTime()) ? at : null);
  const later = () => {
    if (timer) return;
    timer = setTimeout(flush, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };
  // Nothing waits (no note since the last write): nothing to write.
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    threads = pruned(loaded());
    for (const id of own) if (!threads.has(id)) own.delete(id);
    try {
      writeInboxActed(inboxDirPath, threads);
    } catch {
      // A disk that refuses the write: the notes hold in memory until the next one.
    }
  };
  return {
    note(threadId, at = now().toISOString()) {
      if (!isInboxId("msg", threadId)) return;
      const all = loaded();
      if (held(threadId)) own.add(threadId);
      // A time kept from before the clock went back is no longer one: the note replaces it.
      const kept = fresh(all.get(threadId));
      const next = laterActed(kept, at)!;
      if (next === kept) return;
      all.set(threadId, next);
      later();
    },
    at: (threadId) => fresh(loaded().get(threadId)),
    flush,
    sweep() {
      loaded();
      if ([...own].some((id) => !held(id))) later();
    },
  };
}
