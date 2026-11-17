/**
 * Hidden pull requests (the owner's ask, 2026-11-17: "dismiss PRs that need me without closing them … hide them from
 * my inbox"): the PRs the person hid from Reviews, the PR board and their counts. Nothing is done on the forge: a
 * hidden PR stays open there, and stays hidden here until the person shows it again, or it is done: a read sees it
 * merged or closed, or the board's whole read (every PR that asks for the person, is theirs or is assigned to them,
 * and every open PR of the projects) no longer has it. Then its record goes. New activity on it does not bring it back.
 *
 *   inbox/pull-hidden.json   { v: 1, hidden: { [pull key]: { title, url, at } } }
 *
 * Kept on the machine whose window hid it (a window's lists are filtered by its own machine's records, a linked
 * machine's PRs included). The newest `PULL_HIDDEN_KEPT` are kept. Written whole to a temp file, then renamed, 0600; a
 * file that cannot be read is moved aside, never written over. A write that fails (a read-only folder) keeps the
 * records in memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxPull, InboxPullHidden, InboxPullHost, InboxReviewRow } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_HIDDEN_FILE = "pull-hidden.json";
/** The newest this many hidden PRs are kept. */
export const PULL_HIDDEN_KEPT = 500;
/** One write names at most this many PRs (the board's picks). */
const PULL_HIDDEN_MAX = 200;

type Kept = { title: string; url: string; at: string };

function isKept(value: unknown): value is Kept {
  const kept = value as Partial<Kept> | null;
  return !!kept && typeof kept === "object" && typeof kept.title === "string" && typeof kept.url === "string" && typeof kept.at === "string" && Number.isFinite(Date.parse(kept.at));
}

/**
 * A write's body: `hide`, PRs to hide, each `{ key, title, url }` (the list's own); `show`, keys to show again. At
 * least one of them; a URL must be the forge's https link.
 */
export function pullHiddenBodyOf(body: Record<string, unknown>): { hide: { key: string; title: string; url: string }[]; show: string[] } {
  const hide = body.hide ?? [];
  const show = body.show ?? [];
  if (!Array.isArray(hide) || !Array.isArray(show) || hide.length + show.length === 0 || hide.length > PULL_HIDDEN_MAX || show.length > PULL_HIDDEN_MAX) {
    throw new InboxError("validation_error", `hide: PRs to hide, each { key, title, url }; show: their keys. One to ${PULL_HIDDEN_MAX} of each.`, { field: "hide" });
  }
  const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 600;
  return {
    hide: hide.map((entry) => {
      const { key: k, title, url } = (entry ?? {}) as { key?: unknown; title?: unknown; url?: unknown };
      if (!key(k) || typeof title !== "string" || title.length > 1000 || typeof url !== "string" || url.length > 2048 || !url.startsWith("https://")) {
        throw new InboxError("validation_error", "hide: each { key (a PR's key), title, url (its https link) }.", { field: "hide" });
      }
      return { key: k, title, url };
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
  change(input: { hide: readonly { key: string; title: string; url: string }[]; show: readonly string[] }, now: Date): InboxPullHidden[];
  /** A read of the forges: a hidden PR seen merged or closed is forgotten (it left every list on its own). */
  settle(pulls: readonly InboxPull[]): void;
  /**
   * The board's read (`everywhere`): a hidden PR it no longer lists is done (closed: the forge's searches list no
   * closed PR), so it is forgotten; only on a host that answered whole (no error, Others read and nothing cut).
   */
  forgetGone(pulls: readonly InboxPull[], hosts: readonly InboxPullHost[]): void;
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
      for (const [key, value] of Object.entries(parsed.hidden)) if (isKept(value)) hidden.set(key, { title: value.title, url: value.url, at: value.at });
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
      for (const { key, title, url } of hide) {
        if (map.has(key)) continue;
        map.set(key, { title, url, at: now.toISOString() });
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
      if (map.size === 0) return;
      let changed = false;
      for (const pull of pulls) {
        if ((pull.state === "merged" || pull.state === "closed") && map.delete(pull.key)) changed = true;
      }
      if (changed) save(map);
    },
    forgetGone(pulls, hosts) {
      const map = load();
      if (map.size === 0) return;
      const whole = new Set(hosts.filter((h) => !h.error && !h.others_error && !h.others_pending && !h.capped).map((h) => h.host.toLowerCase()));
      const listed = new Set(pulls.map((pull) => pull.key));
      let changed = false;
      for (const key of [...map.keys()]) {
        if (!listed.has(key) && whole.has(key.slice(0, key.indexOf("/")))) changed = map.delete(key) || changed;
      }
      if (changed) save(map);
    },
    shown(pulls) {
      const map = load();
      return map.size === 0 ? [...pulls] : pulls.filter((pull) => !map.has(pull.key));
    },
  };
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
