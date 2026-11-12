/**
 * The Inbox store's record log: what the store keeps on disk, behind one interface.
 *
 * The store (`../store.ts`) holds the rules (picks, Send, idempotency, routing) and the in-memory view; every
 * record it writes or reads back goes through an `InboxLog`. Today's log is per-project append-only JSONL
 * (`jsonl-log.ts`). A second log only has to keep these promises:
 *
 * - `read()` gives back every line still stored (any order; the store sorts by seq) and a floor no new seq
 *   may go under, so a seq is never handed out twice, across a deletion included.
 * - `append()` persists one line for good or throws, in which case the store applies nothing.
 * - A deletion removes the thread's or project's records, keeps `seq` as the floor, and nothing else.
 *
 * Synchronous on purpose: the store is one writer, and a write that is one function call cannot interleave
 * with another request. Files outside the log (blobs, uploads, drafts, pins, snoozes, Decision data's kept
 * lines, the registry) stay files and are not part of it.
 */
import type { InboxCard, InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import type { InboxThreadPullEvent } from "../store";

/**
 * What a log gives back at start: either every line, for the store to replay (today's JSONL), or the current
 * state with the facts that come from the order of lines already worked out (`history.ts`), which the store
 * takes as it is (the SQLite log). Both must read the same: the every-read test holds them to it.
 */
export type InboxLogContents = (
  | {
      /** Every readable line still stored, in any order. Unreadable lines (a torn last line) are left out. */
      lines: InboxLine[];
      state?: never;
    }
  | { state: InboxLogState; lines?: never }
) & {
  /** The highest seq ever handed out that the contents may no longer show (deleted lines, an older store's decisions); 0 for none. */
  seqFloor: number;
};

/** Current state, read from tables: what replaying every line would leave, without the replay. */
export interface InboxLogState {
  /** Each record's latest line, in the order the records' FIRST lines were written (`firstSeq`): the store's maps keep that order. */
  records: { line: InboxLine; firstSeq: number }[];
  /** A resolved thread's archive line seq, by root id (`history.ts` `archiveSeqAfter`). */
  archiveSeq: ReadonlyMap<string, number>;
  /** The roots of threads the person started whose address moved (`movesAddress`). */
  readdressed: ReadonlySet<string>;
  /** Thread names in the order they were taken (`firstLineName`, `agentNamesHere`); `routes: false` only holds the name. */
  names: readonly { projectId: string; name: string; rootId: string; routes: boolean }[];
  /** First-line hashtags in seq order (`firstLineTagKeys`). */
  tags: readonly { key: string; threadId: string; seq: number }[];
  /** Each card as the Board reads it, and its last real change's seq (`cardAfter`). */
  cards: ReadonlyMap<string, { card: InboxCard; heardSeq: number }>;
  /** Each thread's PR adds and removes, oldest first (`pullEventOf`). */
  pullEvents: ReadonlyMap<string, readonly InboxThreadPullEvent[]>;
  /**
   * Steps, PRs and initiatives whose latest line fails its check (an old or broken line): the last record that
   * passed, by `<kind>:<id>`, which the store keeps serving (`apply` skips a failing record and keeps the one before).
   */
  kept?: ReadonlyMap<string, unknown>;
}

/** A dated backup a move between logs left in the inbox folder (`sqlite/backups.ts`): Settings → Storage lists it with Remove. */
export interface InboxStoreBackup {
  /** The folder's name (`backup-2026-11-11-jsonl`): what Remove names. */
  name: string;
  /** What it holds: the JSONL files from before the move into SQLite, or a database from before a move back. */
  kind: "jsonl" | "sqlite";
  /** The day it was made (`YYYY-MM-DD`). */
  date: string;
  bytes: number;
}

/** Settings → Storage: what one project takes on disk. */
export interface InboxLogUsage {
  /** Every byte stored for the project. */
  bytes: number;
  /** The bytes of each stored line that belongs to a thread (messages, questions, annotations, steps, PRs), for the per-thread sizes. */
  lines: { line: InboxLine; bytes: number }[];
}

export interface InboxLog {
  /** Everything stored, read whole at start and after a deletion: lines to replay, or the current state. */
  read(): InboxLogContents;
  /** Persist one line. `project` is the record's project (null for an initiative, which crosses projects). Throws when not written. */
  append(line: InboxLine, project: InboxProject | null): void;
  /** Whether a new project may not take this folder key: something is already stored under it. */
  keyTaken(key: string): boolean;
  /** A new project: its first line, written whole. */
  createProject(project: InboxProject, line: InboxLine): void;
  /** Remove a thread's messages, questions, annotations, steps and PRs (`messageIds`: the thread's messages); keep `seq` as the floor. */
  deleteThread(project: InboxProject, threadId: string, messageIds: ReadonlySet<string>, seq: number): void;
  /** Remove a project and everything stored for it; keep `seq` as the floor. */
  deleteProject(project: InboxProject, seq: number): void;
  /** Every stored line of one card, in any order: its History. */
  cardLines(project: InboxProject, cardId: string): { seq: number; card: InboxCard }[];
  /** What a project takes on disk. */
  usage(project: InboxProject): InboxLogUsage;
  /**
   * A log kept in one file (SQLite): that file's bytes, which Storage counts once instead of each project's lines,
   * and the dated backups beside it. Today's JSONL log leaves it out.
   */
  stored?(): { bytes: number; backups: InboxStoreBackup[] };
  /** Remove one of `stored().backups` by name; false when there is no such backup. */
  removeBackup?(name: string): boolean;
}

/** Builds a store's log for its inbox folder (`<dataDir>/inbox`). */
export type InboxLogFactory = (inboxDir: string) => InboxLog;
