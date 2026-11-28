/**
 * The list's Archived group's writes (approval "inbox-archived-group"): its ⋮ switch, and Unarchive from a row (its
 * hover action, its menu, a swipe on a phone) with the toast's Undo. A linked machine's row goes to that machine
 * through the forward and the outbox, as Archive does; a held one stays in the group and the clock toast says why.
 * Settings → Archived's Unarchive is here too.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi } from '../../api';
import type { Route } from '../../app/route';
import { drawShowArchived } from '../../showArchived';
import { archivedRowOf, dropArchivedRow } from '../queries/archived';

export interface ArchivedGroupHost {
  /** The project the list shows (the group follows it), or null for every project. */
  project: string | null;
  /** Every linked machine's archived threads too. */
  merged: boolean;
  /** The window's filters on the list (machine, agent, tag, the filter's picks), applied to the group's rows. */
  filter: (rows: readonly InboxListRow[]) => readonly InboxListRow[];
  rowOf: (threadId: string) => InboxListRow | null;
  unarchive: (row: InboxListRow) => void;
  setOn: (on: boolean) => void;
}

export interface ArchivedGroupApp {
  project: string | null;
  merged: boolean;
  filter: ArchivedGroupHost['filter'];
  showToast: (toast: { icon: 'check'; lead: string; detail: string; onUndo: () => void }) => void;
  showError: (cause: unknown) => void;
  afterWrite: (written?: readonly string[]) => Promise<unknown>;
  archive: (threadId: string, rootId: string, next: boolean) => Promise<void>;
  go: (route: Route) => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
}

const subjectOf = (row: Pick<InboxListRow, 'subject'>) => `“${row.subject ?? '(no subject)'}”`;

export function useArchivedGroup(app: ArchivedGroupApp): { host: ArchivedGroupHost; unarchiveFromSettings: (row: InboxListRow) => Promise<boolean> } {
  const client = useQueryClient();
  /** Back in the list, in the group its state puts it in, with Undo; the window stays where it is. */
  const unarchive = async (row: InboxListRow) => {
    const restore = dropArchivedRow(client, row.thread_id);
    try {
      await inboxApi.resolve(row.thread_id, false);
    } catch (cause) {
      restore();
      app.showError(cause);
      return;
    }
    await app.afterWrite([row.thread_id]);
    app.showToast({ icon: 'check', lead: 'Back in your Inbox', detail: subjectOf(row), onUndo: () => void app.archive(row.thread_id, row.thread_id, true) });
  };
  const setOn = async (on: boolean) => {
    const draw = drawShowArchived(on);
    try {
      draw.settled((await inboxApi.saveShowArchived(on)).show_archived);
    } catch (cause) {
      draw.settled();
      app.showError(cause);
    }
  };
  /**
   * Settings' Unarchive: the thread goes back to the list, in whatever
   * section its state puts it, and opens there (owner ruling 2026-10-12).
   */
  const unarchiveFromSettings = async (row: InboxListRow): Promise<boolean> => {
    try {
      await inboxApi.resolve(row.thread_id, false);
    } catch (cause) {
      app.showError(cause);
      return false;
    }
    app.go({ page: 'inbox', project: null, thread: row.thread_id });
    await app.refreshList(true);
    app.showToast({ icon: 'check', lead: 'Back in your Inbox', detail: subjectOf(row), onUndo: () => void app.archive(row.thread_id, row.thread_id, true) });
    return true;
  };
  // The host keeps its identity while project, machines and filters stand, so the list does not draw again for it.
  const latest = useRef({ unarchive, setOn });
  latest.current = { unarchive, setOn };
  const host = useMemo<ArchivedGroupHost>(
    () => ({
      project: app.project,
      merged: app.merged,
      filter: app.filter,
      rowOf: (threadId) => archivedRowOf(client, threadId),
      unarchive: (row) => void latest.current.unarchive(row),
      setOn: (on) => void latest.current.setOn(on),
    }),
    [app.project, app.merged, app.filter, client],
  );
  return { host, unarchiveFromSettings };
}
