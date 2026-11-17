/**
 * Hidden pull requests (the owner's ask, 2026-11-17: "dismiss PRs that need me without closing them … hide them from
 * my inbox"): the PRs the person hid from Reviews, the PR board, the Inbox list and their counts. Nothing is done on
 * the forge: a hidden PR stays open there, and stays hidden here until the person shows it again, or a read sees it
 * merged or closed. Then its record goes. A PR missing from a read never counts: a read can be partial (a linked
 * machine asleep, a search cut short, another account), so absence forgets nothing. New activity on it does not bring
 * it back.
 *
 *   inbox/pull-hidden.json   { v: 1, hidden: { [pull key]: { title, url, at, thread_id? } } }
 *
 * Kept on the machine whose window hid it (a window's lists are filtered by its own machine's records, a linked
 * machine's PRs included). The newest `PULL_HIDDEN_KEPT` are kept. Written whole to a temp file, then renamed, 0600; a
 * file that cannot be read is moved aside, never written over. A write that fails (a read-only folder) keeps the
 * records in memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxPull, InboxPullHidden, InboxReviewRow } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_HIDDEN_FILE = "pull-hidden.json";
/** The newest this many hidden PRs are kept. */
export const PULL_HIDDEN_KEPT = 500;
/** One write names at most this many PRs or threads (the window sends more in parts). */
export const PULL_HIDDEN_MAX = 200;

type Kept = { title: string; url: string; at: string; thread_id?: string };
/** A PR to hide: the list's own key, title and link, and the thread it belongs to when known. */
export type PullToHide = { key: string; title: string; url: string; thread_id?: string | null };

function isKept(value: unknown): value is Kept {
  const kept = value as Partial<Kept> | null;
  return (
    !!kept &&
    typeof kept === "object" &&
    typeof kept.title === "string" &&
    typeof kept.url === "string" &&
    typeof kept.at === "string" &&
    Number.isFinite(Date.parse(kept.at)) &&
    (kept.thread_id === undefined || typeof kept.thread_id === "string")
  );
}

const keptOf = (value: Kept): Kept => ({ title: value.title, url: value.url, at: value.at, ...(value.thread_id ? { thread_id: value.thread_id } : {}) });

/**
 * A write's body: `hide`, PRs to hide, each `{ key, title, url }` (the list's own); `threads`, Inbox threads whose open
 * PRs to hide (the Inbox list's row menu and picks); `show`, keys to show again. At least one of them, each at most
 * `PULL_HIDDEN_MAX`; a URL is the forge's http(s) link.
 */
export function pullHiddenBodyOf(body: Record<string, unknown>): { hide: { key: string; title: string; url: string }[]; threads: string[]; show: string[] } {
  const hide = body.hide ?? [];
  const threads = body.threads ?? [];
  const show = body.show ?? [];
  if (!Array.isArray(hide) || !Array.isArray(threads) || !Array.isArray(show) || hide.length + threads.length + show.length === 0) {
    throw new InboxError("validation_error", "hide: PRs to hide, each { key, title, url }; threads: thread ids whose PRs to hide; show: keys to show again.", { field: "hide" });
  }
  if (hide.length > PULL_HIDDEN_MAX || threads.length > PULL_HIDDEN_MAX || show.length > PULL_HIDDEN_MAX) {
    throw new InboxError("validation_error", `That is more than ${PULL_HIDDEN_MAX} at once. Hide or show fewer, then the rest.`, { field: "hide" });
  }
  const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 600;
  return {
    hide: hide.map((entry) => {
      const { key: k, title, url } = (entry ?? {}) as { key?: unknown; title?: unknown; url?: unknown };
      if (!key(k) || typeof title !== "string" || title.length > 1000 || typeof url !== "string" || url.length > 2048 || !/^https?:\/\//.test(url)) {
        throw new InboxError("validation_error", "hide: each { key (a PR's key), title, url (its link) }.", { field: "hide" });
      }
      return { key: k, title, url };
    }),
    threads: threads.map((id) => {
      if (!key(id)) throw new InboxError("validation_error", "threads: each a thread's id.", { field: "threads" });
      return id;
    }),
    show: show.map((k) => {
      if (!key(k)) throw new InboxError("validation_error", "show: each a PR's key.", { field: "show" });
      return k;
    }),
  };
}

export interface InboxPullHiddenStore {
  /** The hidden PRs, newest first. */
  list(): InboxPullHidden[];
  has(key: string): boolean;
  /** Hides and shows again; answers the list now. Hiding a hidden PR keeps its first time. */
  change(input: { hide: readonly PullToHide[]; show: readonly string[] }, now: Date): InboxPullHidden[];
  /**
   * A read of the forges: a hidden PR seen merged or closed is forgotten (it left every list on its own). The only
   * way a record goes besides Show again: a PR the read does not list is kept.
   */
  settle(pulls: readonly Pick<InboxPull, "key" | "state">[]): boolean;
  /** The PRs not hidden. */
  shown<T extends { key: string }>(pulls: readonly T[]): T[];
}

export function createInboxPullHidden(dataDir: string): InboxPullHiddenStore {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_PULL_HIDDEN_FILE);
  let hidden: Map<string, Kept> | null = null;

  const load = (): Map<string, Kept> => {
    if (hidden) return hidden;
    hidden = new Map();
    if (!existsSync(file)) return hidden;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; hidden?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.hidden || typeof parsed.hidden !== "object") throw new Error("not a pull hidden file");
      for (const [key, value] of Object.entries(parsed.hidden)) if (isKept(value)) hidden.set(key, keptOf(value));
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is: the next write replaces nothing it could not move.
      }
      hidden = new Map();
    }
    return hidden;
  };

  const save = (map: Map<string, Kept>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, hidden: Object.fromEntries(map) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // A read-only folder: the records stay in memory.
    }
  };

  const list = (): InboxPullHidden[] =>
    [...load().entries()].map(([key, kept]) => ({ key, ...kept })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));

  return {
    list,
    has: (key) => load().has(key),
    change({ hide, show }, now) {
      const map = load();
      let changed = false;
      for (const key of show) changed = map.delete(key) || changed;
      for (const { key, title, url, thread_id } of hide) {
        if (map.has(key)) continue;
        map.set(key, { title, url, at: now.toISOString(), ...(thread_id ? { thread_id } : {}) });
        changed = true;
      }
      if (map.size > PULL_HIDDEN_KEPT) {
        for (const { key } of list().slice(PULL_HIDDEN_KEPT)) map.delete(key);
      }
      if (changed) save(map);
      return list();
    },
    settle(pulls) {
      const map = load();
      if (map.size === 0) return false;
      let changed = false;
      for (const pull of pulls) {
        if ((pull.state === "merged" || pull.state === "closed") && map.delete(pull.key)) changed = true;
      }
      if (changed) save(map);
      return changed;
    },
    shown(pulls) {
      const map = load();
      return map.size === 0 ? [...pulls] : pulls.filter((pull) => !map.has(pull.key));
    },
  };
}

/**
 * The Inbox list's side of Hide (the owner's ask: "hide them from my inbox list as well"). `inPlay`: each thread's PRs
 * still in play (open, a draft, or not read yet: its own PR list, its review's or hand-off's PRs, and the hidden PRs
 * that belong to it), by key. Answers, per thread, the ones not hidden (the row menu's and the picks' Hide), and the
 * threads whose PRs are all hidden: they leave the list, its counts and the phone's, and stay in search. Nothing is
 * written to the thread: it is back as soon as one of its PRs is shown again, or a hidden one's record goes.
 */
export function threadPullsHidden(inPlay: ReadonlyMap<string, ReadonlyMap<string, PullToHide>>, isHidden: (key: string) => boolean): { gone: Set<string>; hideable: Map<string, PullToHide[]> } {
  const gone = new Set<string>();
  const hideable = new Map<string, PullToHide[]>();
  for (const [threadId, pulls] of inPlay) {
    if (pulls.size === 0) continue;
    const left = [...pulls.values()].filter((pull) => !isHidden(pull.key));
    if (left.length === 0) gone.add(threadId);
    else hideable.set(threadId, left);
  }
  return { gone, hideable };
}

/**
 * Reviews' rows with the hidden PRs gone (the rows were built from the PRs not hidden): a review thread's row that is
 * left with no PR, only because the PRs it owned are hidden, goes too; the thread stays in the Inbox. `ownerOf`: the
 * thread a hidden PR belongs to (its link or the person's hand-off).
 */
export function reviewRowsShown(rows: readonly InboxReviewRow[], hiddenKeys: readonly string[], ownerOf: (key: string) => string | null): InboxReviewRow[] {
  if (hiddenKeys.length === 0) return [...rows];
  const owners = new Set(hiddenKeys.map(ownerOf).filter((id): id is string => !!id));
  return rows.filter((row) => !(row.reviewed && row.thread_id && owners.has(row.thread_id) && row.stacks.length === 0 && row.landed.length === 0 && !row.started));
}
