import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi, type ArchivedModel } from '../api';
import { agentName, dayWords, plural } from '../format';
import { AuthorMark } from '../icons';

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

/** Read the first `count` archived rows of the scope, as many reads as the server's page limit needs. */
async function readArchived(project: string | null, count: number): Promise<Loaded> {
  const rows: InboxListRow[] = [];
  let model: ArchivedModel | null = null;
  do {
    model = await inboxApi.archived({ project, offset: rows.length, limit: Math.min(READ_MAX, count - rows.length) });
    rows.push(...model.threads);
  } while (rows.length < count && rows.length < model.total && model.threads.length > 0);
  return { projects: model.projects, total: model.total, rows };
}

function ArchivedRow({ row, filtered, busy, onUnarchive }: { row: InboxListRow; filtered: boolean; busy: boolean; onUnarchive: () => void }) {
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
          {!filtered && <>{row.project.name} · </>}
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

/**
 * Settings' Archived block (owner ruling 2026-10-12): archived threads leave
 * the list altogether and are listed here, newest archived first, with a
 * project filter when several projects have some. Unarchive puts the thread
 * back in the list and opens it there.
 */
export function ArchivedBlock({ refreshKey, onUnarchive }: ArchivedBlockProps) {
  const [project, setProject] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // How many rows the person has asked to see: a refresh reads that many again.
  const want = useRef(ARCHIVED_PAGE);
  const generation = useRef(0);

  const load = useCallback(async (scope: string | null) => {
    const mine = ++generation.current;
    try {
      const next = await readArchived(scope, want.current);
      if (mine !== generation.current) return;
      // The filtered project has nothing archived any more (the last one came back): every project.
      if (scope !== null && !next.projects.some((p) => p.id === scope)) {
        setProject(null);
        return;
      }
      setLoaded(next);
      setError(null);
    } catch (cause) {
      if (mine === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load(project);
  }, [load, project, refreshKey]);

  const showMore = async () => {
    if (!loaded) return;
    setMore(true);
    try {
      const page = await inboxApi.archived({ project, offset: loaded.rows.length, limit: ARCHIVED_PAGE });
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
      current ? { ...current, total: Math.max(0, current.total - 1), rows: current.rows.filter((r) => r.thread_id !== row.thread_id) } : current,
    );
  };

  const all = loaded?.projects.reduce((n, p) => n + p.archived, 0) ?? 0;
  const left = loaded ? loaded.total - loaded.rows.length : 0;
  return (
    <div className="ib-sblock" data-settings-archived={loaded ? all : ''}>
      <h2>Archived</h2>
      <p>Threads you archived stay out of the list. Unarchive one to put it back and open it.</p>
      {loaded && all > 0 && (
        <div className="ib-srow ib-arcfilter">
          {loaded.projects.length > 1 && (
            <select
              className="ib-select"
              aria-label="Project"
              data-archived-project=""
              value={project ?? ''}
              onChange={(event) => setProject(event.target.value || null)}
            >
              <option value="">All projects ({all})</option>
              {loaded.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.archived})
                </option>
              ))}
            </select>
          )}
          <span className="ib-d" data-archived-count="">
            {plural(loaded.total, 'archived thread')}
          </span>
        </div>
      )}
      {loaded && loaded.rows.length === 0 && (
        <p className="ib-arcnone" data-archived-empty="">
          Nothing archived.
        </p>
      )}
      {loaded && loaded.rows.length > 0 && (
        <ul className="ib-arclist" aria-label="Archived threads">
          {loaded.rows.map((row) => (
            <ArchivedRow
              key={row.thread_id}
              row={row}
              filtered={project !== null || loaded.projects.length === 1}
              busy={busy !== null}
              onUnarchive={() => void unarchive(row)}
            />
          ))}
        </ul>
      )}
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
