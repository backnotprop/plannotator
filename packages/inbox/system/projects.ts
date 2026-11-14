import { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '@plannotator/core/inbox-format';
import type { SystemProjectRow } from '@plannotator/core/inbox-system';
import { inboxApi } from '../api';

/**
 * A project's drawing in words, as Settings' System rows and the Reviews System button say it: "Not drawn yet",
 * "7 sheets", "Drawing 2 of 7" (the drawing phase, sheet by sheet), or "Needs a redraw" (a drawing that does not read).
 */
export function systemStateWords(row: Pick<SystemProjectRow, 'state' | 'sheets' | 'wanted'>): string {
  if (row.state === 'none') return 'Not drawn yet';
  if (row.state === 'drawing') return `Drawing ${row.sheets} of ${row.sheets + row.wanted}`;
  if (row.state === 'broken') return 'Needs a redraw';
  return plural(row.sheets, 'sheet');
}

export interface SystemProjectsState {
  projects: SystemProjectRow[] | null;
  error: string | null;
  /** Read the list again (the menu opened, setup closed). */
  reload: () => void;
}

/**
 * The projects with their drawing's state (`GET /api/inbox/system/projects`), read while `on` (System shows and the
 * page that lists them is open): once on open, and again on `reload`. Off, nothing is asked.
 */
export function useSystemProjects(on: boolean): SystemProjectsState {
  const [projects, setProjects] = useState<SystemProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const reload = useCallback(() => {
    if (!on) return;
    const n = ++asked.current;
    inboxApi
      .systemProjects()
      .then((answer) => {
        if (n !== asked.current) return;
        setProjects(answer.projects);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (n !== asked.current) return;
        setError(cause instanceof Error ? cause.message : 'The projects could not be read.');
      });
  }, [on]);
  useEffect(() => {
    if (on) reload();
    else {
      asked.current += 1;
      setProjects(null);
      setError(null);
    }
  }, [on, reload]);
  return { projects, error, reload };
}
