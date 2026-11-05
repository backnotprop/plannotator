/**
 * Pull requests in the Inbox: which agent thread owns a PR, as the person
 * chose it (Hand to an agent, Launch an agent). The one place that choice lives.
 *
 *   inbox/pull-links.json   { v: 1, links: { [pull key]: { thread_id, at, ask?, theirs? } }, landed?: { [thread and pull key]: InboxReviewLanding }, posted?: { [pull key]: { at, head } } }
 *
 * `ask`: what the hand-off asked the agent for first, a guided review (`guide`) or the person's own curation
 * (`custom`); the stack view says it until the review arrives. `theirs`: every PR of that hand-off was a teammate's
 * (from the Inbox's own pull list, never the window's word); a thread whose PRs are all theirs takes no verdict.
 *
 * Written whole to a temp file, then renamed over the old one. A file that
 * cannot be read is moved aside (`pull-links.json.unreadable-<time>`), never
 * written over. Nothing is written until the first choice. A link whose thread
 * is gone is ignored on read (the linker checks the thread), never pruned here.
 *
 * `landed`: a review thread's PR once it merged or closed (core's `InboxReviewLanding`), so Reviews still knows after
 * the forge's list stopped carrying it.
 *
 * `posted`: the person's last review posted on a PR from here, when and on which commit. The forge's list doesn't say,
 * and an assignment stays on the forge afterwards, so Reviews counts it as their answer. An older record is a bare time.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxReviewLandingId, type InboxReviewLanding, type InboxReviewPosted, type InboxReviewStart } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_LINKS_FILE = "pull-links.json";
/** At most this many PRs keep an owner: the oldest choices go first. */
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
  /** Every key given now belongs to `threadId` (a stack handed over at once). */
  set(keys: readonly string[], threadId: string, extra?: { ask?: InboxPullAsk | null; theirs?: boolean }, at?: string): void;
  /** The thread owns pull requests, every one a teammate's: its reviews take no verdict. */
  theirs(threadId: string): boolean;
  /** The pull requests the thread owns, oldest hand-over first. */
  keys(threadId: string): string[];
  /** Review threads' PRs that merged or closed. */
  landings(): InboxReviewLanding[];
  /**
   * Records `record`, and forgets every thread's record of the PRs in `forget`. A call that changes nothing writes
   * nothing, and one that cannot write (a read-only folder) keeps it in memory: a read of the list never fails for this.
   */
  land(record: readonly InboxReviewLanding[], forget?: readonly string[]): void;
  /** New reviews on local changes, by thread. */
  started(): ReadonlyMap<string, InboxReviewStart>;
  start(threadId: string, start: InboxReviewStart): void;
  /** Pull key → the person's last review posted on it from here. */
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
        if ((start?.kind === "local" || start?.kind === "link") && typeof start.at === "string") started.set(threadId, start);
      }
      for (const [key, landing] of Object.entries(parsed.landed ?? {})) {
        if (typeof landing?.thread_id === "string" && typeof landing.key === "string" && (landing.state === "merged" || landing.state === "closed") && typeof landing.url === "string" && typeof landing.number === "number") landed.set(key, landing);
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
