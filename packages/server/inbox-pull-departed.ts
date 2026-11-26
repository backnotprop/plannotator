/**
 * A PR that left the list stays readable (the owner, 2026-11-23: "if I ever create a thread for any PR … it should
 * never disappear on me"). A list read that no longer names a PR (someone else merged or closed it, a search stopped
 * returning it) moves it here, so a page of it that is open in the window still reads its diff, details and files.
 * It is never listed again: only those reads take it (`InboxPulls` `readable`).
 *
 * Bounds: at most `INBOX_PULLS_DEPARTED_MAX` PRs, each for `INBOX_PULLS_DEPARTED_MS` from when it left; a PR listed
 * again leaves this map. A host the next list did not ask (its sign-in check failed, or no CLI here is signed in to
 * it any more) keeps its PRs: a restart while offline once dropped them all, and the open page said "gone". Never
 * kept: one the person hid (`hidden`, asked at each read; a hidden repository counts). The repository rule (a project
 * removed) is the caller's, as for a listed PR. A hidden PR is never written to the file either: each write leaves out
 * every PR hidden by then.
 *
 * With a `file` (under the Inbox's data folder, 0600) the map is kept on disk too, so a page reopened after a reload
 * or a restart of this Inbox still reads its PR; it is written only when it changed.
 */
import type { InboxPull } from "@plannotator/core/inbox-types";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const INBOX_PULLS_DEPARTED_MAX = 50;
export const INBOX_PULLS_DEPARTED_MS = 12 * 60 * 60_000;

export interface DepartedPulls {
  /**
   * A list read replaced `before` with `after`. A host it could not ask (its sign-in check failed: offline, a Mac that
   * just woke, a forge down for longer than the sign-in keep) drops nothing: only the age and the count do.
   */
  note(before: ReadonlyMap<string, InboxPull>, after: ReadonlyMap<string, InboxPull>): void;
  get(key: string): InboxPull | undefined;
  /** A PR read from the forge for a page open on it (`InboxPulls.pull`): kept, or its copy replaced, as one that left. */
  put(pull: InboxPull): void;
  size(): number;
}

/** A saved entry taken by its shape: anything else is left out. */
function savedEntry(value: unknown): { pull: InboxPull; at: number } | null {
  if (!value || typeof value !== "object") return null;
  const { pull, at } = value as { pull?: Partial<InboxPull>; at?: unknown };
  if (typeof at !== "number" || !pull || typeof pull !== "object") return null;
  if (typeof pull.key !== "string" || typeof pull.host !== "string" || typeof pull.repo !== "string" || typeof pull.number !== "number" || typeof pull.state !== "string") return null;
  return { pull: pull as InboxPull, at };
}

export function createDepartedPulls(options: { now: () => number; hidden?: (key: string) => boolean; file?: string }): DepartedPulls {
  const kept = new Map<string, { pull: InboxPull; at: number }>();
  const file = options.file ?? null;
  let written = "";
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; pulls?: unknown };
      for (const value of saved.v === 1 && Array.isArray(saved.pulls) ? saved.pulls.slice(-INBOX_PULLS_DEPARTED_MAX) : []) {
        const entry = savedEntry(value);
        if (entry && options.now() - entry.at <= INBOX_PULLS_DEPARTED_MS) kept.set(entry.pull.key, entry);
      }
    } catch {
      // None yet, or unreadable: nothing kept from before.
    }
  }
  const save = () => {
    if (!file) return;
    const text = `${JSON.stringify({ v: 1, pulls: [...kept.values()] })}\n`;
    if (text === written) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, text, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
      written = text;
    } catch {
      // A read-only folder: kept in memory only.
    }
  };
  /** Never kept, in memory or on disk: one the person hid (since it was kept too). At most `INBOX_PULLS_DEPARTED_MAX` asks. */
  const forgetHidden = () => {
    if (options.hidden) for (const key of [...kept.keys()]) if (options.hidden(key)) kept.delete(key);
  };
  return {
    put(pull) {
      const was = kept.get(pull.key);
      kept.delete(pull.key);
      if (!options.hidden?.(pull.key)) kept.set(pull.key, { pull, at: was?.at ?? options.now() });
      forgetHidden();
      while (kept.size > INBOX_PULLS_DEPARTED_MAX) kept.delete(kept.keys().next().value!);
      save();
    },
    note(before, after) {
      const at = options.now();
      for (const key of after.keys()) kept.delete(key);
      for (const [key, pull] of before) {
        if (after.has(key)) continue;
        // Newest last: the bound drops the oldest first.
        kept.delete(key);
        kept.set(key, { pull, at });
      }
      forgetHidden();
      while (kept.size > INBOX_PULLS_DEPARTED_MAX) kept.delete(kept.keys().next().value!);
      save();
    },
    get(key) {
      const entry = kept.get(key);
      if (!entry) return undefined;
      if (options.now() - entry.at > INBOX_PULLS_DEPARTED_MS || options.hidden?.(key)) {
        kept.delete(key);
        save();
        return undefined;
      }
      return entry.pull;
    },
    size: () => kept.size,
  };
}
