/**
 * The last patch read of each PR, for a page open on one that no list names any more (the owner, 2026-11-23: "my
 * diff while I'm viewing diffs or refresh it just goes away"). Its header says the forge did not answer, or no longer
 * has the PR, "showing its last read": this is that last read. Before, only the 5-minute read cache answered a reload,
 * so the line was true for five minutes and only until this Inbox restarted; a forge 404 lost the patch at once.
 *
 * In memory: the last `INBOX_PULL_LAST_DIFFS_MAX` patches read, by PR, scope and base (not by head: a PR that left
 * the list keeps the head it was last read at). On disk (`file`, 0600, under the Inbox's own folder): only those of a
 * PR no list names (`save`), newest first, at most `INBOX_PULL_LAST_DIFFS_SAVED_MAX` of them and
 * `INBOX_PULL_LAST_DIFFS_SAVED_BYTES` of patch in all, written only when that set changed. Never a cache hit: only a
 * read that failed answers from here (`InboxPulls.diff`).
 */
import type { InboxPullDiffAnswer, InboxPullState } from "@plannotator/core/inbox-types";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const INBOX_PULL_LAST_DIFFS_MAX = 24;
export const INBOX_PULL_LAST_DIFFS_SAVED_MAX = 12;
export const INBOX_PULL_LAST_DIFFS_SAVED_BYTES = 24 * 1024 * 1024;

export interface LastDiff {
  /** When it was read here. */
  at: number;
  answer: InboxPullDiffAnswer;
}

export interface LastDiffs {
  put(id: string, answer: InboxPullDiffAnswer): void;
  get(id: string): LastDiff | undefined;
  /** Keeps on disk the patches of the PRs no list names (`unlisted`), within the bounds. */
  save(unlisted: (key: string) => boolean): void;
}

/** The id a patch is kept under: its PR, scope and base. */
export const lastDiffId = (key: string, scope: string, base: string): string => `${key}\u0000${scope}\u0000${base}`;

const STATES: ReadonlySet<string> = new Set<InboxPullState>(["open", "draft", "merged", "closed"]);

/** A saved entry taken by its shape: anything else is left out. */
function savedEntry(value: unknown): { id: string; at: number; answer: InboxPullDiffAnswer } | null {
  if (!value || typeof value !== "object") return null;
  const { id, at, answer } = value as { id?: unknown; at?: unknown; answer?: Partial<InboxPullDiffAnswer> };
  if (typeof id !== "string" || typeof at !== "number" || !answer || typeof answer !== "object") return null;
  if (typeof answer.key !== "string" || typeof answer.scope !== "string" || typeof answer.patch !== "string" || typeof answer.base !== "string" || typeof answer.head !== "string") return null;
  if (answer.state !== undefined && !STATES.has(answer.state)) return null;
  return { id, at, answer: answer as InboxPullDiffAnswer };
}

export function createLastDiffs(options: { now: () => number; file?: string }): LastDiffs {
  const kept = new Map<string, LastDiff>();
  const file = options.file ?? null;
  /** The ids and times on disk now: the same set writes nothing. */
  let written = "";
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; diffs?: unknown };
      for (const value of saved.v === 1 && Array.isArray(saved.diffs) ? saved.diffs.slice(0, INBOX_PULL_LAST_DIFFS_SAVED_MAX) : []) {
        const entry = savedEntry(value);
        // Oldest first in memory, as `put` keeps them: the file is newest first.
        if (entry && !kept.has(entry.id)) kept.set(entry.id, { at: entry.at, answer: entry.answer });
      }
      const order = [...kept.entries()].reverse();
      kept.clear();
      for (const [id, entry] of order) kept.set(id, entry);
      written = [...kept].reverse().map(([id, entry]) => `${id}\u0001${entry.at}`).join("\u0002");
    } catch {
      // None yet, or unreadable: nothing kept from before.
    }
  }
  return {
    put(id, answer) {
      kept.delete(id);
      kept.set(id, { at: options.now(), answer });
      while (kept.size > INBOX_PULL_LAST_DIFFS_MAX) kept.delete(kept.keys().next().value!);
    },
    get: (id) => kept.get(id),
    save(unlisted) {
      if (!file) return;
      const out: { id: string; at: number; answer: InboxPullDiffAnswer }[] = [];
      let bytes = 0;
      for (const [id, entry] of [...kept].reverse()) {
        if (out.length >= INBOX_PULL_LAST_DIFFS_SAVED_MAX) break;
        if (!unlisted(entry.answer.key)) continue;
        bytes += entry.answer.patch.length;
        if (bytes > INBOX_PULL_LAST_DIFFS_SAVED_BYTES) break;
        out.push({ id, at: entry.at, answer: entry.answer });
      }
      const signature = out.map((entry) => `${entry.id}\u0001${entry.at}`).join("\u0002");
      if (signature === written) return;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify({ v: 1, diffs: out })}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, file);
        written = signature;
      } catch {
        // A read-only folder: kept in memory only.
      }
    },
  };
}

/**
 * A kept patch's state with what was learned of the PR since it was read (`newer`, a read of the PR itself or an
 * action here): a PR closed when its patch was read and reopened since says open. Merged is final.
 */
export function withNewerState(answer: InboxPullDiffAnswer, at: number, newer: { at: number; state: InboxPullState; merged_at: string | null } | undefined): InboxPullDiffAnswer {
  if (!answer.state || answer.state === "merged" || !newer || newer.at < at || newer.state === answer.state) return answer;
  return { ...answer, state: newer.state, merged_at: newer.merged_at };
}
