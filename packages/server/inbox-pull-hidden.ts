/**
 * Hidden pull requests (the owner's ask, 2026-11-17: "dismiss PRs that need me without closing them … hide them from
 * my inbox"): the PRs the person hid from Reviews, the PR board, the Inbox list and their counts. Nothing is done on
 * the forge: a hidden PR stays open there, and stays hidden here until the person shows it again, or a read sees it
 * merged or closed. Then its record goes. A PR missing from a read never counts: a read can be partial (a linked
 * machine asleep, a search cut short, another account), so absence forgets nothing. New activity on it does not bring
 * it back.
 *
 *   inbox/pull-hidden.json   { v: 1, hidden: { [pull key]: { title, url, at, thread_id?, head_repo? } }, repos?: { [repo key]: { label, at } }, back?: { [thread id]: at }, rehid?: { [thread id]: at } }
 *
 * `repos`: repositories the person hid from the board (`inboxPullRepoKey`): every PR in one is left out of the board
 * and Reviews as a hidden PR is, new ones too, until the repository is shown again (a record goes only then; the newest
 * `PULL_HIDDEN_KEPT`). It never takes a thread out of the Inbox list: that reads PRs hidden one by one only (`atOf`).
 * A renamed repository has a new key, so its PRs show again; the old name stays in Hidden until Show again.
 *
 * `back`: a thread the Inbox list left out for its hidden PRs and that came back on new activity after the hide (an
 * agent message, a question, a prompt, a stop or failure, the person's own send, a snooze coming due), with that
 * activity's time, so it stays back once that activity is read or over; a newer hide takes it out again.
 * `rehid`: a thread whose PRs were all hidden already (it came back, or began after they were hidden) that the person
 * hid again from the Inbox list: it counts as a hide of its own, newer than that activity. Undo takes it off.
 *
 * Kept on the machine whose window hid it (a window's lists are filtered by its own machine's records, a linked
 * machine's PRs included). The newest `PULL_HIDDEN_KEPT` are kept. Written whole to a temp file, then renamed, 0600; a
 * file that cannot be read is moved aside, never written over. A write that fails (a read-only folder) keeps the
 * records in memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxPullRepoOfKey, type InboxPull, type InboxPullHidden, type InboxRepoHidden, type InboxReviewRow } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_HIDDEN_FILE = "pull-hidden.json";
/** The newest this many hidden PRs are kept (and as many threads' returns). */
export const PULL_HIDDEN_KEPT = 500;
/** One write names at most this many PRs or threads (the window sends more in parts). */
export const PULL_HIDDEN_MAX = 200;

type Kept = { title: string; url: string; at: string; thread_id?: string; head_repo?: string };
/** A PR to hide: the list's own key, title and link, and the thread it belongs to when known. */
export type PullToHide = { key: string; title: string; url: string; thread_id?: string | null; head_repo?: string | null };

function isKept(value: unknown): value is Kept {
  const kept = value as Partial<Kept> | null;
  return (
    !!kept &&
    typeof kept === "object" &&
    typeof kept.title === "string" &&
    typeof kept.url === "string" &&
    typeof kept.at === "string" &&
    Number.isFinite(Date.parse(kept.at)) &&
    (kept.thread_id === undefined || typeof kept.thread_id === "string") &&
    (kept.head_repo === undefined || typeof kept.head_repo === "string")
  );
}

const keptOf = (value: Kept): Kept => ({ title: value.title, url: value.url, at: value.at, ...(value.thread_id ? { thread_id: value.thread_id } : {}), ...(value.head_repo ? { head_repo: value.head_repo } : {}) });

/**
 * A write's body: `hide`, PRs to hide, each `{ key, title, url }` (the list's own); `threads`, Inbox threads whose open
 * PRs to hide (the Inbox list's row menu and picks); `show`, keys to show again; `hide_repos`, repositories to hide,
 * each `{ key, label }` (`inboxPullRepoKey`); `show_repos`, their keys to show again. At least one of them, each at most
 * `PULL_HIDDEN_MAX`; a URL is the forge's http(s) link.
 */
export function pullHiddenBodyOf(body: Record<string, unknown>): { hide: { key: string; title: string; url: string }[]; threads: string[]; show: string[]; show_threads: string[]; hide_repos: { key: string; label: string }[]; show_repos: string[] } {
  const lists = [body.hide, body.threads, body.show, body.show_threads, body.hide_repos, body.show_repos].map((list) => list ?? []);
  if (!lists.every((list): list is unknown[] => Array.isArray(list)) || lists.reduce((n, list) => n + list.length, 0) === 0) {
    throw new InboxError("validation_error", "hide: PRs to hide, each { key, title, url }; threads: thread ids whose PRs to hide; show: keys to show again; show_threads: threads hidden again to show; hide_repos: repositories, each { key, label }; show_repos: their keys.", { field: "hide" });
  }
  const [hide, threads, show, showThreads, hideRepos, showRepos] = lists;
  if (lists.some((list) => list.length > PULL_HIDDEN_MAX)) {
    throw new InboxError("validation_error", `That is more than ${PULL_HIDDEN_MAX} at once. Hide or show fewer, then the rest.`, { field: "hide" });
  }
  const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 600;
  return {
    hide: hide!.map((entry) => {
      const { key: k, title, url } = (entry ?? {}) as { key?: unknown; title?: unknown; url?: unknown };
      if (!key(k) || typeof title !== "string" || title.length > 1000 || typeof url !== "string" || url.length > 2048 || !/^https?:\/\//.test(url)) {
        throw new InboxError("validation_error", "hide: each { key (a PR's key), title, url (its link) }.", { field: "hide" });
      }
      return { key: k, title, url };
    }),
    threads: threads!.map((id) => {
      if (!key(id)) throw new InboxError("validation_error", "threads: each a thread's id.", { field: "threads" });
      return id;
    }),
    show: show!.map((k) => {
      if (!key(k)) throw new InboxError("validation_error", "show: each a PR's key.", { field: "show" });
      return k;
    }),
    show_threads: showThreads!.map((id) => {
      if (!key(id)) throw new InboxError("validation_error", "show_threads: each a thread's id.", { field: "show_threads" });
      return id;
    }),
    hide_repos: hideRepos!.map((entry) => {
      const { key: k, label } = (entry ?? {}) as { key?: unknown; label?: unknown };
      if (!key(k) || k.includes("#") || !k.includes("/") || typeof label !== "string" || label.length > 600) {
        throw new InboxError("validation_error", "hide_repos: each { key (host/owner/repo), label }.", { field: "hide_repos" });
      }
      return { key: k.toLowerCase(), label };
    }),
    show_repos: showRepos!.map((k) => {
      if (!key(k)) throw new InboxError("validation_error", "show_repos: each a repository's key.", { field: "show_repos" });
      return k.toLowerCase();
    }),
  };
}

export interface InboxPullHiddenStore {
  /** The hidden PRs, newest first. */
  list(): InboxPullHidden[];
  /** Whether a PR is hidden: itself, or its repository. */
  has(key: string): boolean;
  /**
   * When it was hidden one by one, or null: a repository's hide does not count. The Inbox list's threads read this
   * only (a repository hidden from the board never takes a thread out).
   */
  atOf(key: string): string | null;
  /** The hidden repositories, newest first. */
  repos(): InboxRepoHidden[];
  /** When the thread came back on activity newer than its hides, or null. */
  backOf(threadId: string): string | null;
  /** Threads that came back, each with its activity's time (a later time replaces an earlier one). */
  markBack(back: readonly { thread_id: string; at: string }[]): void;
  /** When a thread that came back was hidden again from the Inbox list (its PRs were hidden already), or null. */
  rehidOf(threadId: string): string | null;
  /** Hide threads again (`rehid`); `show` takes those marks off (Undo). */
  rehide(input: { hide: readonly string[]; show: readonly string[] }, now: Date): void;
  /** Hides and shows again; answers the list now. Hiding a hidden PR keeps its first time. */
  change(input: { hide: readonly PullToHide[]; show: readonly string[]; hide_repos?: readonly { key: string; label: string }[]; show_repos?: readonly string[] }, now: Date): InboxPullHidden[];
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
  const back = new Map<string, string>();
  const repos = new Map<string, { label: string; at: string }>();
  const rehid = new Map<string, string>();

  const load = (): Map<string, Kept> => {
    if (hidden) return hidden;
    hidden = new Map();
    if (!existsSync(file)) return hidden;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; hidden?: Record<string, unknown>; back?: Record<string, unknown>; rehid?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.hidden || typeof parsed.hidden !== "object") throw new Error("not a pull hidden file");
      for (const [key, value] of Object.entries(parsed.hidden)) if (isKept(value)) hidden.set(key, keptOf(value));
      for (const [thread, at] of Object.entries(parsed.back && typeof parsed.back === "object" ? parsed.back : {})) if (typeof at === "string" && Number.isFinite(Date.parse(at))) back.set(thread, at);
      const savedRepos = (parsed as { repos?: unknown }).repos;
      for (const [repo, value] of Object.entries(savedRepos && typeof savedRepos === "object" ? savedRepos : {})) {
        const kept = value as { label?: unknown; at?: unknown } | null;
        if (kept && typeof kept.label === "string" && typeof kept.at === "string" && Number.isFinite(Date.parse(kept.at))) repos.set(repo, { label: kept.label, at: kept.at });
      }
      for (const [thread, at] of Object.entries(parsed.rehid && typeof parsed.rehid === "object" ? parsed.rehid : {})) if (typeof at === "string" && Number.isFinite(Date.parse(at))) rehid.set(thread, at);
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is: the next write replaces nothing it could not move.
      }
      hidden = new Map();
      back.clear();
      repos.clear();
      rehid.clear();
    }
    return hidden;
  };

  const save = (map: Map<string, Kept>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, hidden: Object.fromEntries(map), ...(repos.size > 0 ? { repos: Object.fromEntries(repos) } : {}), ...(back.size > 0 ? { back: Object.fromEntries(back) } : {}), ...(rehid.size > 0 ? { rehid: Object.fromEntries(rehid) } : {}) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // A read-only folder: the records stay in memory.
    }
  };

  const list = (): InboxPullHidden[] =>
    [...load().entries()].map(([key, kept]) => ({ key, ...kept })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));

  return {
    list,
    has: (key) => load().has(key) || repos.has(inboxPullRepoOfKey(key)),
    atOf: (key) => load().get(key)?.at ?? null,
    repos: () => {
      load();
      return [...repos].map(([key, repo]) => ({ key, ...repo })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
    },
    backOf: (threadId) => {
      load();
      return back.get(threadId) ?? null;
    },
    markBack(entries) {
      const map = load();
      let changed = false;
      for (const { thread_id, at } of entries) {
        if ((back.get(thread_id) ?? "") >= at) continue;
        back.set(thread_id, at);
        changed = true;
      }
      if (!changed) return;
      if (back.size > PULL_HIDDEN_KEPT) {
        for (const [thread] of [...back].sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, back.size - PULL_HIDDEN_KEPT)) back.delete(thread);
      }
      save(map);
    },
    rehidOf: (threadId) => {
      load();
      return rehid.get(threadId) ?? null;
    },
    rehide({ hide, show }, now) {
      const map = load();
      let changed = false;
      for (const thread of show) changed = rehid.delete(thread) || changed;
      for (const thread of hide) {
        rehid.set(thread, now.toISOString());
        changed = true;
      }
      if (rehid.size > PULL_HIDDEN_KEPT) {
        for (const [thread] of [...rehid].sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, rehid.size - PULL_HIDDEN_KEPT)) rehid.delete(thread);
      }
      if (changed) save(map);
    },
    change({ hide, show, hide_repos = [], show_repos = [] }, now) {
      const map = load();
      let changed = false;
      for (const key of show_repos) changed = repos.delete(key) || changed;
      for (const { key, label } of hide_repos) {
        if (repos.has(key)) continue;
        repos.set(key, { label, at: now.toISOString() });
        changed = true;
      }
      if (repos.size > PULL_HIDDEN_KEPT) {
        for (const [key] of [...repos].sort((a, b) => (a[1].at < b[1].at ? -1 : 1)).slice(0, repos.size - PULL_HIDDEN_KEPT)) repos.delete(key);
      }
      for (const key of show) changed = map.delete(key) || changed;
      for (const { key, title, url, thread_id, head_repo } of hide) {
        if (map.has(key)) continue;
        map.set(key, { title, url, at: now.toISOString(), ...(thread_id ? { thread_id } : {}), ...(head_repo ? { head_repo } : {}) });
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
      return map.size === 0 && repos.size === 0 ? [...pulls] : pulls.filter((pull) => !map.has(pull.key) && !repos.has(inboxPullRepoOfKey(pull.key)));
    },
  };
}

/**
 * The Inbox list's side of Hide (the owner's ask: "hide them from my inbox list as well"). `inPlay`: each thread's PRs
 * still in play (open, a draft, or not read yet: its own PR list, its review's or hand-off's PRs, and the hidden PRs
 * that belong to it), by key. Answers, per thread, the ones not hidden (the row menu's and the picks' Hide), and the
 * threads whose PRs are all hidden, each with its newest hide: they leave the list, its counts and the phone's
 * (`threadStaysHidden` says for how long), and stay in search. Nothing is written to the thread: it is back as soon as
 * one of its PRs is shown again, a hidden one's record goes, or something new happens in it.
 */
export function threadPullsHidden(inPlay: ReadonlyMap<string, ReadonlyMap<string, PullToHide>>, hiddenAt: (key: string) => string | null): { gone: Map<string, string>; hideable: Map<string, PullToHide[]> } {
  const gone = new Map<string, string>();
  const hideable = new Map<string, PullToHide[]>();
  for (const [threadId, pulls] of inPlay) {
    if (pulls.size === 0) continue;
    let newest = "";
    const left: PullToHide[] = [];
    for (const pull of pulls.values()) {
      const at = hiddenAt(pull.key);
      if (at === null) left.push(pull);
      else if (at > newest) newest = at;
    }
    if (left.length === 0) gone.set(threadId, newest);
    else hideable.set(threadId, left);
  }
  return { gone, hideable };
}

/**
 * Whether a thread whose PRs are all hidden (`hiddenAt`, the newest hide among them) stays out of the Inbox list: not
 * while pinned (the person chose to keep it in sight), not while snoozed (the Snoozed view lists it as it is), and not
 * once anything newer than that hide happened in it (`activity`: its last message, a question and the person's own
 * send included, a snooze that came due, its agent's prompt, stop or failure, or an earlier return). The PR stays hidden.
 */
export function threadStaysHidden(hiddenAt: string, thread: { pinned: boolean; snoozed: boolean; activity: readonly (string | null | undefined)[] }): boolean {
  if (thread.pinned || thread.snoozed) return false;
  // An activity in the same millisecond as the hide counts as newer: showing errs on the safe side.
  return thread.activity.every((at) => !at || at < hiddenAt);
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
