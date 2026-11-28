/**
 * What the Agents list keeps of each agent session on disk (`agents-first-seen.json` in the Inbox folder): when this
 * Inbox first saw it, and the first thread it got with that thread's name as it read then. So the list's fixed order
 * and its last-resort name (inbox-agents-list.ts) survive what happens on every release (a plugin reload starts the
 * session's connection again, with a later `started_at`, then the Inbox restarts and forgets what it held in memory),
 * and a rename or deletion of that thread later.
 *
 * The time only ever moves earlier, and the thread is kept as first written. An entry is refreshed at most once an
 * hour while its session is seen; one not refreshed for INBOX_FIRST_SEEN_FORGET_MS is forgotten (its agent left the
 * list long before), and at most INBOX_FIRST_SEEN_KEPT are kept, the most recently refreshed. A file that cannot be
 * read or written is none: the list then goes by what the connections and messages say.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INBOX_FIRST_SEEN_KEPT = 1000;
export const INBOX_FIRST_SEEN_FORGET_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_MS = 60 * 60 * 1000;
const SESSION_ID_MAX = 200;
const THREAD_NAME_MAX = 300;

export interface InboxFirstSeenEntry {
  /** First seen, epoch ms. */
  first: number;
  /** The first thread it got, its name as read when first kept. */
  thread?: { id: string; name: string };
}

interface Entry extends InboxFirstSeenEntry {
  /** When the entry was last written. */
  at: number;
}

export interface InboxFirstSeen {
  get(session: string): InboxFirstSeenEntry | undefined;
  /**
   * `session` was first seen at `first` or earlier (`at`: now), with `thread` its first thread when known. Returns what
   * is kept now: the earliest time, and the thread first kept.
   */
  note(session: string, first: number, at: number, thread?: { id: string; name: string } | null): InboxFirstSeenEntry;
}

const fine = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const okThread = (value: unknown): { id: string; name: string } | undefined => {
  const { id, name } = (value ?? {}) as Record<string, unknown>;
  return typeof id === "string" && id && id.length <= SESSION_ID_MAX && typeof name === "string" && name.trim() ? { id, name: name.slice(0, THREAD_NAME_MAX) } : undefined;
};

function readEntries(file: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
    const sessions = parsed && typeof parsed.sessions === "object" && parsed.sessions && !Array.isArray(parsed.sessions) ? (parsed.sessions as Record<string, unknown>) : {};
    for (const [session, value] of Object.entries(sessions)) {
      const raw = (value ?? {}) as Record<string, unknown>;
      const thread = okThread(raw.thread);
      if (session && session.length <= SESSION_ID_MAX && fine(raw.first) && fine(raw.at)) out.set(session, { first: raw.first, at: raw.at, ...(thread ? { thread } : {}) });
    }
  } catch {
    // None yet, or unreadable: nothing kept.
  }
  return out;
}

const shown = (entry: Entry): InboxFirstSeenEntry => ({ first: entry.first, ...(entry.thread ? { thread: entry.thread } : {}) });

/** The entries kept in `dir` (the Inbox folder); null keeps them in memory only. */
export function createInboxFirstSeen(dir: string | null): InboxFirstSeen {
  const file = dir ? join(dir, "agents-first-seen.json") : null;
  const entries = file ? readEntries(file) : new Map<string, Entry>();
  let writing = false;
  const write = () => {
    writing = false;
    if (!file || !dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, sessions: Object.fromEntries(entries) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // Not kept this time; the next change tries again.
    }
  };
  const changed = (at: number) => {
    for (const [session, entry] of entries) if (at - entry.at > INBOX_FIRST_SEEN_FORGET_MS) entries.delete(session);
    if (entries.size > INBOX_FIRST_SEEN_KEPT) {
      const newest = [...entries].sort((a, b) => b[1].at - a[1].at).slice(0, INBOX_FIRST_SEEN_KEPT);
      entries.clear();
      for (const [session, entry] of newest) entries.set(session, entry);
    }
    // One write for every change a list read or poll makes at once.
    if (!writing) {
      writing = true;
      queueMicrotask(write);
    }
  };
  return {
    get: (session) => {
      const entry = entries.get(session);
      return entry ? shown(entry) : undefined;
    },
    note(session, first, at, thread) {
      const known = entries.get(session);
      if (!fine(first) || !session || session.length > SESSION_ID_MAX) return known ? shown(known) : { first };
      const next: Entry = { first: known ? Math.min(known.first, first) : first, at, ...((known?.thread ?? okThread(thread)) ? { thread: known?.thread ?? okThread(thread)! } : {}) };
      if (!known || next.first < known.first || (!known.thread && next.thread) || at - known.at >= REFRESH_MS) {
        entries.set(session, next);
        changed(at);
        return shown(next);
      }
      return shown(known);
    },
  };
}
