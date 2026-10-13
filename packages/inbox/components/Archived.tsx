import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi, type ArchivedModel } from '../api';
import { agentName, dayWords, plural } from '../format';
import { AuthorMark, Icon } from '../icons';

/** Rows the block reads at a time ("Show more" reads the next ones). The server allows up to 200 per read. */
export const ARCHIVED_PAGE = 50;
const READ_MAX = 200;

export interface ArchivedBlockProps {
  /**
   * The store's cursor as the window last read it: when it moves (an agent
   * wrote, the person archived from a thread), the block reads again.
   */
  refreshKey: number | null;
  /**
   * Unarchive: the thread goes back to the list, in whatever section its
   * state puts it, and the window opens it there. Resolves false when the
   * Inbox refused (the window has already said why), so the row stays.
   */
  onUnarchive: (row: InboxListRow) => Promise<boolean>;
}

interface Loaded {
  projects: ArchivedModel['projects'];
  total: number;
  rows: InboxListRow[];
}

/** Read the first `count` archived rows, as many reads as the server's page limit needs. */
async function readArchived(count: number): Promise<Loaded> {
  const rows: InboxListRow[] = [];
  let model: ArchivedModel | null = null;
  do {
    model = await inboxApi.archived({ offset: rows.length, limit: Math.min(READ_MAX, count - rows.length) });
    rows.push(...model.threads);
  } while (rows.length < count && rows.length < model.total && model.threads.length > 0);
  return { projects: model.projects, total: model.total, rows };
}

/** One archived thread: no project label, since a header names it when several projects have some. */
function ArchivedRow({ row, busy, onUnarchive }: { row: InboxListRow; busy: boolean; onUnarchive: () => void }) {
  const subject = row.subject ?? '(no subject)';
  return (
    <li className="ib-srow ib-arcrow" data-archived-thread={row.thread_id}>
      <AuthorMark author={row.author} />
      <span className="ib-arcinfo">
        <span className="ib-arcsub">
          {row.thread_name && <span className="ib-key"><span className="ib-keyt">{row.thread_name}</span></span>}
          <span className="ib-st">{subject}</span>
        </span>
        <span className="ib-d">
          {agentName(row.author)} · Archived {row.resolved_at ? dayWords(row.resolved_at) : ''} · {plural(row.message_count, 'message')}
        </span>
      </span>
      <span className="ib-r">
        <button
          type="button"
          className="ib-btn ib-sm"
          disabled={busy}
          aria-label={`Unarchive ${subject}`}
          data-archived-unarchive=""
          onClick={onUnarchive}
        >
          Unarchive
        </button>
      </span>
    </li>
  );
}

/** The loaded rows grouped by project, a group per project in the order its newest archived row appears. */
function groupByProject(rows: readonly InboxListRow[]): { id: string; name: string; rows: InboxListRow[] }[] {
  const groups = new Map<string, { id: string; name: string; rows: InboxListRow[] }>();
  for (const row of rows) {
    const group = groups.get(row.project.id) ?? { id: row.project.id, name: row.project.name, rows: [] };
    group.rows.push(row);
    groups.set(row.project.id, group);
  }
  return [...groups.values()];
}

/**
 * Settings → Archived (owner ruling 2026-10-12; drawn as the Archived
 * section of the design of record `.product/approved/inbox-settings-tabs/`,
 * whose heading and lede the section supplies): archived threads leave
 * the list altogether and are listed here, newest archived first. When
 * several projects have some, the rows sit under a small header per project
 * with its count ("billing · 2"). Unarchive puts the thread back in the list
 * and opens it there.
 */
export function ArchivedBlock({ refreshKey, onUnarchive }: ArchivedBlockProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // How many rows the person has asked to see: a refresh reads that many again.
  const want = useRef(ARCHIVED_PAGE);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await readArchived(want.current);
      if (mine !== generation.current) return;
      setLoaded(next);
      setError(null);
    } catch (cause) {
      if (mine === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const showMore = async () => {
    if (!loaded) return;
    setMore(true);
    try {
      const page = await inboxApi.archived({ offset: loaded.rows.length, limit: ARCHIVED_PAGE });
      const seen = new Set(loaded.rows.map((row) => row.thread_id));
      const rows = [...loaded.rows, ...page.threads.filter((row) => !seen.has(row.thread_id))];
      want.current = Math.max(want.current, rows.length);
      setLoaded({ projects: page.projects, total: page.total, rows });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMore(false);
    }
  };

  const unarchive = async (row: InboxListRow) => {
    setBusy(row.thread_id);
    const done = await onUnarchive(row);
    setBusy(null);
    if (!done) return;
    // The window has usually moved to the thread by now; if not, the row leaves here.
    setLoaded((current) =>
      current
        ? {
            projects: current.projects
              .map((p) => (p.id === row.project.id ? { ...p, archived: p.archived - 1 } : p))
              .filter((p) => p.archived > 0),
            total: Math.max(0, current.total - 1),
            rows: current.rows.filter((r) => r.thread_id !== row.thread_id),
          }
        : current,
    );
  };

  const grouped = (loaded?.projects.length ?? 0) > 1;
  const left = loaded ? loaded.total - loaded.rows.length : 0;
  const renderRows = (rows: readonly InboxListRow[], label: string) => (
    <ul className="ib-arclist ib-card" aria-label={label}>
      {rows.map((row) => (
        <ArchivedRow key={row.thread_id} row={row} busy={busy !== null} onUnarchive={() => void unarchive(row)} />
      ))}
    </ul>
  );
  return (
    <div className="ib-arcblock" data-settings-archived={loaded ? loaded.total : ''}>
      {loaded && loaded.total > 0 && (
        <p className="ib-arcnone" data-archived-count="">
          {plural(loaded.total, 'archived thread')}
        </p>
      )}
      {loaded && loaded.rows.length === 0 && (
        <div className="ib-card ib-sempty" data-archived-empty="">
          <Icon name="archive" />
          Nothing archived. Archive a thread from its header to move it here.
        </div>
      )}
      {loaded && loaded.rows.length > 0 && !grouped && renderRows(loaded.rows, 'Archived threads')}
      {loaded &&
        grouped &&
        groupByProject(loaded.rows).map((group) => {
          const count = loaded.projects.find((p) => p.id === group.id)?.archived ?? group.rows.length;
          return (
            <section key={group.id} className="ib-arcgroup" data-archived-group={group.id} aria-label={`${group.name}, ${plural(count, 'archived thread')}`}>
              <h3 className="ib-arcghead">
                {group.name} <span className="ib-d">· {count}</span>
              </h3>
              {renderRows(group.rows, `Archived in ${group.name}`)}
            </section>
          );
        })}
      {loaded && left > 0 && (
        <div className="ib-srow">
          <span className="ib-d" data-archived-shown="">
            Showing {loaded.rows.length} of {loaded.total}
          </span>
          <span className="ib-r">
            <button type="button" className="ib-btn ib-sm" disabled={more} data-archived-more="" onClick={() => void showMore()}>
              Show {Math.min(ARCHIVED_PAGE, left)} more
            </button>
          </span>
        </div>
      )}
      {error && <div className="ib-error">{error}</div>}
    </div>
  );
}
