import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxReviewLandingId, type InboxReviewLanding, type InboxReviewPosted, type InboxReviewStart } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_LINKS_FILE = "pull-links.json";
export const INBOX_PULL_LINKS_MAX = 2_000;

export type InboxPullAsk = "guide" | "custom";

export interface InboxPullOwner {
  thread_id: string;
  at: string;
  ask?: InboxPullAsk;
  theirs?: true;
}

export interface InboxPullLinks {
  get(key: string): InboxPullOwner | null;
  all(): ReadonlyMap<string, InboxPullOwner>;
  set(keys: readonly string[], threadId: string, extra?: { ask?: InboxPullAsk | null; theirs?: boolean }, at?: string): void;
  theirs(threadId: string): boolean;
  keys(threadId: string): string[];
  landings(): InboxReviewLanding[];
  land(record: readonly InboxReviewLanding[], forget?: readonly string[]): void;
  started(): ReadonlyMap<string, InboxReviewStart>;
  start(threadId: string, start: InboxReviewStart): void;
  posted(): ReadonlyMap<string, InboxReviewPosted>;
  /** The review went, on commit `head`: never fails the post that already happened (a read-only folder keeps it in memory). */
  markPosted(key: string, head: string, at?: string): void;
}

export function createInboxPullLinks(dataDir: string): InboxPullLinks {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_PULL_LINKS_FILE);
  let links: Map<string, InboxPullOwner> | null = null;
  const landed = new Map<string, InboxReviewLanding>();
  const started = new Map<string, InboxReviewStart>();
  const posted = new Map<string, InboxReviewPosted>();

  const load = (): Map<string, InboxPullOwner> => {
    if (links) return links;
    links = new Map();
    if (!existsSync(file)) return links;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; started?: Record<string, InboxReviewStart>; links?: Record<string, unknown>; landed?: Record<string, InboxReviewLanding>; posted?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.links || typeof parsed.links !== "object") throw new Error("not a pull links file");
      for (const [key, value] of Object.entries(parsed.links)) {
        const owner = value as Partial<InboxPullOwner>;
        if (typeof owner?.thread_id === "string" && typeof owner.at === "string") {
          links.set(key, {
            thread_id: owner.thread_id,
            at: owner.at,
            ...(owner.ask === "guide" || owner.ask === "custom" ? { ask: owner.ask } : {}),
            ...(owner.theirs === true ? { theirs: true as const } : {}),
          });
        }
      }
      for (const [threadId, start] of Object.entries(parsed.started ?? {})) {
        if ((start?.kind === "local" || start?.kind === "link" || start?.kind === "walkthrough") && typeof start.at === "string") started.set(threadId, start);
      }
      for (const [key, landing] of Object.entries(parsed.landed ?? {})) {
        if (typeof landing?.thread_id === "string" && typeof landing.key === "string" && (landing.state === "merged" || landing.state === "closed") && typeof landing.url === "string" && typeof landing.number === "number") {
          const own = `${landing.key}${landing.platform === "gitlab" && !landing.key.endsWith(":pull") ? ":pull" : ""}`.toLowerCase();
          landed.set(own === landing.key ? key : inboxReviewLandingId({ key: own, thread_id: landing.thread_id }), { ...landing, key: own });
        }
      }
      for (const [key, value] of Object.entries(parsed.posted ?? {})) {
        const review = value as Partial<InboxReviewPosted> | string | null;
        if (typeof review === "string") posted.set(key, { at: review, head: null });
        else if (typeof review?.at === "string") posted.set(key, { at: review.at, head: typeof review.head === "string" ? review.head : null });
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
    writeFileSync(temp, `${JSON.stringify({ v: 1, links: Object.fromEntries(map), ...(started.size > 0 ? { started: Object.fromEntries(started) } : {}), ...(landed.size > 0 ? { landed: Object.fromEntries(landed) } : {}), ...(posted.size > 0 ? { posted: Object.fromEntries(posted) } : {}) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };

  return {
    get: (key) => load().get(key) ?? null,
    all: () => load(),
    set(keys, threadId, extra = {}, at = new Date().toISOString()) {
      const map = load();
      for (const key of keys) {
        map.delete(key);
        map.set(key, { thread_id: threadId, at, ...(extra.ask ? { ask: extra.ask } : {}), ...(extra.theirs ? { theirs: true as const } : {}) });
      }
      while (map.size > INBOX_PULL_LINKS_MAX) map.delete(map.keys().next().value!);
      save(map);
    },
    landings() {
      load();
      return [...landed.values()];
    },
    land(record, forget = []) {
      const map = load();
      let changed = false;
      for (const [id, landing] of landed) {
        if (forget.includes(landing.key)) changed = landed.delete(id) || changed;
      }
      for (const landing of record) {
        const id = inboxReviewLandingId(landing);
        landed.delete(id);
        landed.set(id, landing);
        changed = true;
      }
      while (landed.size > INBOX_PULL_LINKS_MAX) landed.delete(landed.keys().next().value!);
      if (!changed) return;
      try {
        save(map);
      } catch (cause) {
        console.error(`inbox: could not save the landed pull requests: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    started() {
      load();
      return started;
    },
    start(threadId, start) {
      const map = load();
      started.delete(threadId);
      started.set(threadId, start);
      while (started.size > INBOX_PULL_LINKS_MAX) started.delete(started.keys().next().value!);
      save(map);
    },
    posted() {
      load();
      return posted;
    },
    markPosted(key, head, at = new Date().toISOString()) {
      const map = load();
      posted.delete(key);
      posted.set(key, { at, head });
      while (posted.size > INBOX_PULL_LINKS_MAX) posted.delete(posted.keys().next().value!);
      try {
        save(map);
      } catch (cause) {
        console.error(`inbox: could not save the posted review: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    keys(threadId) {
      const out: string[] = [];
      for (const [key, owner] of load()) if (owner.thread_id === threadId) out.push(key);
      return out;
    },
    theirs(threadId) {
      let any = false;
      for (const owner of load().values()) {
        if (owner.thread_id !== threadId) continue;
        if (!owner.theirs) return false;
        any = true;
      }
      return any;
    },
  };
}
