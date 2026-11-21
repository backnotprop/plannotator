/**
 * Plannotator Inbox: each `:::run` block's last run, kept on disk (`inbox/runs.json`, 0600) so a card does not
 * read as never run after the Inbox restarts, and so a run the Inbox lost (a crash, a kill) still gets its word to
 * the agent when the Inbox starts again. It holds what the card shows: the state, the exit code, the times and the
 * output's last lines with secrets already hidden. Never a value.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InboxRunView } from "./inbox-run";

export interface InboxRunRecord {
  message_id: string;
  key: string;
  /** The block's title and folder as the card showed them, for a report written after a restart. */
  title: string;
  folder: string;
  view: InboxRunView;
  /** It was running when this was written. */
  live: boolean;
  /** Its process (group leader) while it ran, and when this Inbox started it: a lost run is looked for by these. */
  pid?: number | null;
  spawned_at?: number | null;
  /** When this Inbox last wrote it while it ran: a lost run's group counts as its own only with a process started by then. */
  seen_at?: number | null;
}

export interface InboxRunJournal {
  load: () => InboxRunRecord[];
  save: (records: readonly InboxRunRecord[]) => void;
}

/** Lines a record keeps: what the agent's report has. */
export const INBOX_RUN_JOURNAL_LINES = 60;
/** Records kept: the newest. */
const MAX_RECORDS = 300;

export function fileRunJournal(file: string): InboxRunJournal {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: unknown };
        return Array.isArray(parsed.runs) ? (parsed.runs as InboxRunRecord[]).filter((r) => r && typeof r.message_id === "string" && typeof r.key === "string" && r.view) : [];
      } catch {
        return [];
      }
    },
    save: (records) => {
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        const kept = records.slice(-MAX_RECORDS).map((r) => ({ ...r, view: { ...r.view, lines: r.view.lines.slice(-INBOX_RUN_JOURNAL_LINES) } }));
        writeFileSync(temp, `${JSON.stringify({ version: 1, runs: kept })}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, file);
      } catch (error) {
        process.stderr.write(`Inbox: a run's record was not written: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    },
  };
}

/** For tests: records in memory, shared across "restarts" by passing the same journal. */
export function memoryRunJournal(records: InboxRunRecord[] = []): InboxRunJournal & { records: InboxRunRecord[] } {
  const journal = {
    records: records.map((r) => structuredClone(r)),
    load: () => journal.records.map((r) => structuredClone(r)),
    save: (records: readonly InboxRunRecord[]) => {
      journal.records = records.map((r) => structuredClone(r));
    },
  };
  return journal;
}
