/**
 * Settings → Activity's read (`GET /api/inbox/activity`): each thread's messages
 * counted by hour over a span. Pure: the store hands it each thread's message
 * times, and nothing here writes or logs (thread names stay in the answer).
 */
import type { InboxActivityModel, InboxActivityThread } from "@plannotator/core/inbox-types";

export const INBOX_ACTIVITY_HOUR_MS = 3_600_000;

/** One thread as the store sees it. */
export interface InboxActivitySource {
  thread_id: string;
  project_id: string;
  /** Read only for a thread that has a message in the span. */
  name: () => string | null;
  /** Each message's time (ms), in the order they were written. */
  times: readonly number[];
}

export interface InboxActivitySpan {
  fromMs: number;
  toMs: number;
  /** Null: every project. */
  projectId: string | null;
  /** Whether a thread's project counts as the one asked for (combined projects are one). */
  inProject?: (projectId: string) => boolean;
}

/**
 * Count each thread's messages by hour over `[fromMs, toMs)`. An hour is
 * `floor((t - fromMs) / 1 h)`, so the caller's `fromMs` sets where hours begin.
 * Threads with no message in the span are left out; the rest keep the order
 * they began in (first message, then id).
 */
export function inboxActivity(threads: Iterable<InboxActivitySource>, span: InboxActivitySpan): InboxActivityModel {
  const { fromMs, toMs, projectId } = span;
  const hourCount = Math.max(0, Math.ceil((toMs - fromMs) / INBOX_ACTIVITY_HOUR_MS));
  const rows: { start: number; row: InboxActivityThread }[] = [];
  for (const thread of threads) {
    const { times } = thread;
    if (times.length === 0) continue;
    if (projectId !== null && !(span.inProject ? span.inProject(thread.project_id) : thread.project_id === projectId)) continue;
    let first = Infinity;
    let last = -Infinity;
    for (const t of times) {
      if (t < first) first = t;
      if (t > last) last = t;
    }
    if (last < fromMs || first >= toMs) continue;
    const counts = new Map<number, number>();
    for (const t of times) {
      if (t < fromMs || t >= toMs) continue;
      const hour = Math.floor((t - fromMs) / INBOX_ACTIVITY_HOUR_MS);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const hours: number[] = [];
    for (const hour of [...counts.keys()].sort((a, b) => a - b)) hours.push(hour, counts.get(hour)!);
    rows.push({
      start: first,
      row: {
        thread_id: thread.thread_id,
        name: thread.name(),
        project_id: thread.project_id,
        started_at: new Date(first).toISOString(),
        last_at: new Date(last).toISOString(),
        total: times.length,
        hours,
      },
    });
  }
  rows.sort((a, b) => a.start - b.start || a.row.thread_id.localeCompare(b.row.thread_id));
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hour_count: hourCount, project_id: projectId, threads: rows.map((entry) => entry.row) };
}
