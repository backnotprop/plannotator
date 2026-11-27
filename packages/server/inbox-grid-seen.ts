/**
 * Grid's looks (approval "inbox-agent-grid": landed and dropped work "stays until seen"): for each thread, the last
 * time its line was on the person's screen in a visible tab, and the line's last landing or drop that look showed.
 * It lives on the thread's own machine, as the thread's other read state does (`threads/:id/seen`): a linked
 * machine's window sends its look there through the forward (rule 8's `set`), a phone through the door, and every
 * window reads it back on the list's rows (`grid_seen`).
 *
 *   inbox/grid-seen.json   { v: 1, seen: { [thread id]: { through, at } } }
 *
 * Each field keeps the larger value (a look held in an outbox lands as of then, never over a later one). A time
 * ahead of this machine's clock is now. A look is kept while this Inbox holds its thread (never dropped for age: a
 * line still shown or in Earlier keeps its look). Written whole to a temp file,
 * then renamed, 0600; a file that cannot be read is moved aside, never written over. Nothing is written until a
 * window with Grid on sends a look.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_GRID_SEEN_FILE = "grid-seen.json";
/** One write names at most this many threads (a page of lines). */
export const GRID_SEEN_MAX = 200;

export interface GridSeen {
  through: number;
  at: number;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A write's body: `seen`, each `{ thread, through, at }`. Times ahead of `now` are now. */
export function gridSeenOf(body: Record<string, unknown>, now: number): { thread: string; through: number; at: number }[] {
  const seen = body.seen;
  if (!Array.isArray(seen) || seen.length === 0 || seen.length > GRID_SEEN_MAX) {
    throw new InboxError("validation_error", `seen: the lines looked at (1 to ${GRID_SEEN_MAX}), each { thread, through, at }.`, { field: "seen" });
  }
  return seen.map((entry) => {
    const { thread, through, at } = (entry ?? {}) as { thread?: unknown; through?: unknown; at?: unknown };
    if (typeof thread !== "string" || !/^[A-Za-z0-9_]{1,80}$/.test(thread) || !isTime(through) || !isTime(at)) {
      throw new InboxError("validation_error", "seen: each { thread (a thread id), through (ms), at (ms) }.", { field: "seen" });
    }
    return { thread, through: Math.min(through, now), at: Math.min(at, now) };
  });
}

export interface InboxGridSeenStore {
  get(thread: string): GridSeen | undefined;
  /** Keeps the larger of each field; answers what is held now for those threads. */
  mark(seen: readonly { thread: string; through: number; at: number }[]): Record<string, GridSeen>;
}

/** `holds`: whether this Inbox still holds a thread (archived ones too); a look at one it no longer holds is dropped. */
export function createInboxGridSeen(dataDir: string, holds?: (thread: string) => boolean): InboxGridSeenStore {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_GRID_SEEN_FILE);
  let held: Map<string, GridSeen> | null = null;

  const load = (): Map<string, GridSeen> => {
    if (held) return held;
    held = new Map();
    if (!existsSync(file)) return held;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; seen?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.seen || typeof parsed.seen !== "object") throw new Error("not a grid seen file");
      for (const [thread, value] of Object.entries(parsed.seen)) {
        const look = value as Partial<GridSeen> | null;
        if (look && isTime(look.through) && isTime(look.at)) held.set(thread, { through: look.through, at: look.at });
      }
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is: the next write replaces nothing it could not move.
      }
      held = new Map();
    }
    return held;
  };

  const save = (map: Map<string, GridSeen>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, seen: Object.fromEntries(map) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // A read-only folder: the look stays in memory.
    }
  };

  return {
    get: (thread) => load().get(thread),
    mark(seen) {
      const map = load();
      let changed = false;
      for (const { thread, through, at } of seen) {
        const was = map.get(thread);
        const next = { through: Math.max(was?.through ?? 0, through), at: Math.max(was?.at ?? 0, at) };
        if (was && was.through === next.through && was.at === next.at) continue;
        map.set(thread, next);
        changed = true;
      }
      // Only a thread this Inbox no longer holds is forgotten: one that is still here may still have a line (shown or
      // in Earlier), and losing its look would bring a seen landing or drop back as unseen.
      if (changed && holds) for (const thread of map.keys()) if (!holds(thread)) map.delete(thread);
      if (changed) save(map);
      return Object.fromEntries(seen.flatMap(({ thread }) => (map.has(thread) ? [[thread, map.get(thread)!]] : [])));
    },
  };
}
