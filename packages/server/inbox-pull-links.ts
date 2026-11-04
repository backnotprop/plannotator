/**
 * Pull requests in the Inbox: which agent thread owns a PR, as the person
 * chose it (Hand to an agent, Launch an agent). The one place that choice lives.
 *
 *   inbox/pull-links.json   { v: 1, links: { [pull key]: { thread_id, at } } }
 *
 * Written whole to a temp file, then renamed over the old one. A file that
 * cannot be read is moved aside (`pull-links.json.unreadable-<time>`), never
 * written over. Nothing is written until the first choice. A link whose thread
 * is gone is ignored on read (the linker checks the thread), never pruned here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_LINKS_FILE = "pull-links.json";
/** At most this many PRs keep an owner: the oldest choices go first. */
export const INBOX_PULL_LINKS_MAX = 2_000;

export interface InboxPullOwner {
  thread_id: string;
  at: string;
}

export interface InboxPullLinks {
  get(key: string): InboxPullOwner | null;
  all(): ReadonlyMap<string, InboxPullOwner>;
  /** Every key given now belongs to `threadId` (a stack handed over at once). */
  set(keys: readonly string[], threadId: string, at?: string): void;
}

export function createInboxPullLinks(dataDir: string): InboxPullLinks {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_PULL_LINKS_FILE);
  let links: Map<string, InboxPullOwner> | null = null;

  const load = (): Map<string, InboxPullOwner> => {
    if (links) return links;
    links = new Map();
    if (!existsSync(file)) return links;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; links?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.links || typeof parsed.links !== "object") throw new Error("not a pull links file");
      for (const [key, value] of Object.entries(parsed.links)) {
        const owner = value as Partial<InboxPullOwner>;
        if (typeof owner?.thread_id === "string" && typeof owner.at === "string") links.set(key, { thread_id: owner.thread_id, at: owner.at });
      }
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is: the next write replaces nothing it could not move.
      }
      links = new Map();
    }
    return links;
  };

  const save = (map: Map<string, InboxPullOwner>) => {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, links: Object.fromEntries(map) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };

  return {
    get: (key) => load().get(key) ?? null,
    all: () => load(),
    set(keys, threadId, at = new Date().toISOString()) {
      const map = load();
      for (const key of keys) {
        map.delete(key);
        map.set(key, { thread_id: threadId, at });
      }
      while (map.size > INBOX_PULL_LINKS_MAX) map.delete(map.keys().next().value!);
      save(map);
    },
  };
}
