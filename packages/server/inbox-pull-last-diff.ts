/**
 * The last patch read of each PR, for a page open on one that no list names any more (the owner, 2026-11-23: "my
 * diff while I'm viewing diffs or refresh it just goes away"). Its header says the forge did not answer, or no longer
 * has the PR, "showing its last read": this is that last read. Before, only the 5-minute read cache answered a reload,
 * so the line was true for five minutes and only until this Inbox restarted; a forge 404 lost the patch at once.
 *
 * In memory: the last `INBOX_PULL_LAST_DIFFS_MAX` patches read, by PR, scope and base (not by head: a PR that left
 * the list keeps the head it was last read at). On disk (`file`, 0600, under the Inbox's own folder): only those of a
 * PR no list names and the person did not hide (`save`), newest first, at most `INBOX_PULL_LAST_DIFFS_SAVED_MAX` of
 * them and `INBOX_PULL_LAST_DIFFS_SAVED_BYTES` in the file in all (one larger alone is left out, not the rest),
 * written only when that set or one of its patches changed. Never a cache hit: only a read that failed answers from
 * here (`InboxPulls.diff`).
 */
import type { InboxPullDiffAnswer, InboxPullState } from "@plannotator/core/inbox-types";
import { createHash } from "node:crypto";
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

/** What a patch is known by on disk: its answer but the patch, and the patch's length and hash (each answer once). */
const fingerprints = new WeakMap<InboxPullDiffAnswer, { print: string; bytes: number }>();
function fingerprintOf(answer: InboxPullDiffAnswer): { print: string; bytes: number } {
  let known = fingerprints.get(answer);
  if (!known) {
    const { patch, ...rest } = answer;
    // The bytes the answer takes in the file (UTF-8, as JSON writes it): the bound counts these, not UTF-16 units.
    known = { print: `${JSON.stringify(rest)}\u0001${patch.length}\u0001${createHash("sha1").update(patch).digest("hex")}`, bytes: Buffer.byteLength(JSON.stringify(answer)) };
    fingerprints.set(answer, known);
  }
  return known;
}

export function createLastDiffs(options: { now: () => number; file?: string; hidden?: (key: string) => boolean }): LastDiffs {
  const kept = new Map<string, LastDiff>();
  const file = options.file ?? null;
  /**
   * The set on disk now, by id and fingerprint, in no order: the same patches read again (only their time and order
   * moved) write nothing. Their time on disk stays the first read's: it only orders them against a state learned
   * since (`withNewerState`), and none is learned before a restart reads the file.
   */
  let written = "";
  const signatureOf = (entries: readonly { id: string; answer: InboxPullDiffAnswer }[]) =>
    entries
      .map((entry) => `${entry.id}\u0001${fingerprintOf(entry.answer).print}`)
      .sort()
      .join("\u0002");
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
      written = signatureOf([...kept].map(([id, entry]) => ({ id, answer: entry.answer })));
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
        // Never one the person hid.
        if (!unlisted(entry.answer.key) || options.hidden?.(entry.answer.key)) continue;
        // One that would pass the bound is left out, never the ones after it.
        const size = fingerprintOf(entry.answer).bytes;
        if (bytes + size > INBOX_PULL_LAST_DIFFS_SAVED_BYTES) continue;
        bytes += size;
        out.push({ id, at: entry.at, answer: entry.answer });
      }
      const signature = signatureOf(out);
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
