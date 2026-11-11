/**
 * The store's record log. Every log must keep these promises:
 * - `read()` returns every line still stored and a seq floor, so a seq is never handed out twice, across a deletion included.
 * - `append()` persists one line for good or throws, in which case the store applies nothing.
 * - A deletion removes the thread's or project's records and keeps `seq` as the floor.
 *
 * Synchronous on purpose: a write that is one call cannot interleave with another request.
 */
import type { InboxCard, InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import type { InboxThreadPullEvent } from "../store";

/** Either every line, for the store to replay, or the current state with the order-dependent facts worked out (`history.ts`). Both must read the same. */
export type InboxLogContents = (
  | {
      /** Unreadable lines (a torn last line) are left out. */
      lines: InboxLine[];
      state?: never;
    }
  | { state: InboxLogState; lines?: never }
) & {
  /** The highest seq ever handed out that the contents may no longer show; 0 for none. */
  seqFloor: number;
};

/** What replaying every line would leave, without the replay. */
export interface InboxLogState {
  /** In the order the records' FIRST lines were written (`firstSeq`). */
  records: { line: InboxLine; firstSeq: number }[];
  /** By root id. */
  archiveSeq: ReadonlyMap<string, number>;
  readdressed: ReadonlySet<string>;
  /** In the order taken; `routes: false` only holds the name. */
  names: readonly { projectId: string; name: string; rootId: string; routes: boolean }[];
  tags: readonly { key: string; threadId: string; seq: number }[];
  cards: ReadonlyMap<string, { card: InboxCard; heardSeq: number }>;
  pullEvents: ReadonlyMap<string, readonly InboxThreadPullEvent[]>;
  /** Where a latest line fails its check: the last record that passed, by `<kind>:<id>`. */
  kept?: ReadonlyMap<string, unknown>;
}

/** A dated backup a move between logs left in the inbox folder. */
export interface InboxStoreBackup {
  /** The folder's name, e.g. `backup-2026-11-11-jsonl`. */
  name: string;
  kind: "jsonl" | "sqlite";
  /** `YYYY-MM-DD`. */
  date: string;
  bytes: number;
}

/** What one project takes on disk. */
export interface InboxLogUsage {
  bytes: number;
  /** Lines that belong to a thread, for per-thread sizes. */
  lines: { line: InboxLine; bytes: number }[];
}

export interface InboxLog {
  /** Read whole at start and after a deletion. */
  read(): InboxLogContents;
  /** `project` is null for an initiative, which crosses projects. Throws when not written. */
  append(line: InboxLine, project: InboxProject | null): void;
  keyTaken(key: string): boolean;
  createProject(project: InboxProject, line: InboxLine): void;
  /** Keeps `seq` as the floor. */
  deleteThread(project: InboxProject, threadId: string, messageIds: ReadonlySet<string>, seq: number): void;
  /** Keeps `seq` as the floor. */
  deleteProject(project: InboxProject, seq: number): void;
  cardLines(project: InboxProject, cardId: string): { seq: number; card: InboxCard }[];
  usage(project: InboxProject): InboxLogUsage;
  /** A log kept in one file (SQLite): that file's bytes, counted once instead of each project's lines, and the backups beside it. */
  stored?(): { bytes: number; backups: InboxStoreBackup[] };
  /** False when there is no such backup. */
  removeBackup?(name: string): boolean;
}

export type InboxLogFactory = (inboxDir: string) => InboxLog;
