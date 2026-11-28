/**
 * "Changed since you looked" (approval "inbox-pr-dashboard", q-6cf84c0b: "remembered per PR across windows and
 * machines"): the head commit each PR was last opened at in the PR page, and when. It lives on the machine that lists
 * the PR, as the Board's look lives on its project's machine (`cards/seen`): a linked machine's window sends its look
 * there through the forward (rule 8's `set`), and every window reads it back on that machine's board (`looked` on
 * each PR of `GET /api/inbox/pulls`).
 *
 *   inbox/pull-looked.json   { v: 1, looked: { [pull key]: { sha, at } } }
 *
 * The newer look wins (`at`, the time the person opened it, in ms): a look held in an outbox while this machine slept
 * lands as of then, never over a later one. The newest `PULL_LOOKED_KEPT` are kept. Written whole to a temp file,
 * then renamed, 0600; a file that cannot be read is moved aside, never written over. A write that fails (a read-only
 * folder) keeps the look in memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxPull, InboxPullLooked } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_LOOKED_FILE = "pull-looked.json";
/** The newest this many PRs are kept. */
export const PULL_LOOKED_KEPT = 400;
/** One write names at most this many PRs (a stack's layers). */
const PULL_LOOKED_MAX_SEEN = 100;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A look as kept: a whole commit id and a time. */
export function isPullLooked(value: unknown): value is InboxPullLooked {
  const look = value as Partial<InboxPullLooked> | null;
  return !!look && typeof look === "object" && typeof look.sha === "string" && SHA.test(look.sha) && typeof look.at === "number" && Number.isFinite(look.at) && look.at > 0;
}

/** A write's body: `seen`, the PRs looked at, each with the head shown and when. A time ahead of `now` is now. */
export function pullLookedSeenOf(body: Record<string, unknown>, now: number): { key: string; sha: string; at: number }[] {
  const seen = body.seen;
  if (!Array.isArray(seen) || seen.length === 0 || seen.length > PULL_LOOKED_MAX_SEEN) {
    throw new InboxError("validation_error", `seen: the PRs looked at (1 to ${PULL_LOOKED_MAX_SEEN}), each { key, sha, at }.`, { field: "seen" });
  }
  return seen.map((entry) => {
    const { key, sha, at } = (entry ?? {}) as { key?: unknown; sha?: unknown; at?: unknown };
    const look = { sha: typeof sha === "string" ? sha.toLowerCase() : sha, at };
    if (typeof key !== "string" || key.length === 0 || key.length > 600 || !isPullLooked(look)) {
      throw new InboxError("validation_error", "seen: each { key (a PR's key), sha (a whole commit id), at (ms) }.", { field: "seen" });
    }
    return { key, sha: look.sha, at: Math.min(look.at, now) };
  });
}

export interface InboxPullLookedStore {
  all(): ReadonlyMap<string, InboxPullLooked>;
  /** Keeps each look newer than the one held; answers what is held now for those PRs. */
  mark(seen: readonly { key: string; sha: string; at: number }[]): Record<string, InboxPullLooked>;
  /** The list's PRs, each with its look when one is held. */
  on(pulls: readonly InboxPull[]): InboxPull[];
}

export function createInboxPullLooked(dataDir: string): InboxPullLookedStore {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_PULL_LOOKED_FILE);
  let looked: Map<string, InboxPullLooked> | null = null;

  const load = (): Map<string, InboxPullLooked> => {
    if (looked) return looked;
    looked = new Map();
    if (!existsSync(file)) return looked;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; looked?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.looked || typeof parsed.looked !== "object") throw new Error("not a pull looked file");
      for (const [key, value] of Object.entries(parsed.looked)) if (isPullLooked(value)) looked.set(key, { sha: value.sha, at: value.at });
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is: the next write replaces nothing it could not move.
      }
      looked = new Map();
    }
    return looked;
  };

  const save = (map: Map<string, InboxPullLooked>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, looked: Object.fromEntries(map) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // A read-only folder: the look stays in memory.
    }
  };

  return {
    all: () => load(),
    mark(seen) {
      const map = load();
      let changed = false;
      for (const { key, sha, at } of seen) {
        const held = map.get(key);
        if (held && held.at >= at) continue;
        map.set(key, { sha, at });
        changed = true;
      }
      if (map.size > PULL_LOOKED_KEPT) {
        const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - PULL_LOOKED_KEPT);
        for (const [key] of oldest) map.delete(key);
      }
      if (changed) save(map);
      return Object.fromEntries(seen.flatMap(({ key }) => (map.has(key) ? [[key, map.get(key)!]] : [])));
    },
    on(pulls) {
      const map = load();
      return pulls.map((pull) => {
        const look = map.get(pull.key);
        return look ? { ...pull, looked: look } : pull;
      });
    },
  };
}
