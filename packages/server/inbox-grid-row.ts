/**
 * What a list row carries for Grid (approval "inbox-agent-grid"), on this Inbox's own rows: `grid_seen`, the person's
 * last look at the thread's line (inbox-grid-seen.ts), and `steps_progress`, its checklist as Grid reads it (only
 * while the Checklist switch is on: `lists` null otherwise). A linked machine's rows carry their own, from there, so
 * Grid draws a linked computer's work as this one's. One pass over the stored lists per list read.
 */
import { inboxStepsProgress, type InboxListRow, type InboxSteps } from "@plannotator/core/inbox-types";
import type { InboxGridSeenStore } from "./inbox-grid-seen";

/**
 * A row as a list read that did not ask for Grid gets it (`grid=1` absent): without Grid's fields, as before Grid. A
 * linked machine's row read while Grid is on here carries them; another read here must not.
 */
export function gridRowStripped<R extends InboxListRow>(row: R): R {
  const items = row.pulls?.items !== undefined;
  if (!items && !("grid_seen" in row) && !("steps_progress" in row)) return row;
  const { grid_seen: _seen, steps_progress: _steps, ...rest } = row;
  if (!items) return rest as R;
  const { items: _items, ...pulls } = row.pulls!;
  return { ...rest, pulls } as R;
}

export function gridRowDecorator(seen: Pick<InboxGridSeenStore, "get">, lists: readonly InboxSteps[] | null): (row: InboxListRow) => InboxListRow {
  // The thread's latest list that holds steps (a thread may have one per agent session).
  const latest = new Map<string, InboxSteps>();
  for (const list of lists ?? []) {
    if (list.steps.length === 0) continue;
    const was = latest.get(list.thread_id);
    if (!was || list.updated_at > was.updated_at) latest.set(list.thread_id, list);
  }
  return (row) => {
    const look = seen.get(row.thread_id);
    const list = latest.get(row.thread_id);
    if (!look && !list) return row;
    const out: InboxListRow = { ...row };
    if (look) out.grid_seen = { through: look.through, at: look.at };
    if (list) {
      const progress = inboxStepsProgress(list.steps);
      const at = list.steps.reduce((last, step) => (step.at > last ? step.at : last), list.steps[0]!.at);
      out.steps_progress = { done: progress.done, total: progress.total, doing: progress.doing, at };
    }
    return out;
  };
}
