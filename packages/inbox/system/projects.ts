import { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '@plannotator/core/inbox-format';
import type { SystemProjectRow } from '@plannotator/core/inbox-system';
import { inboxApi } from '../api';

export function systemStateWords(row: Pick<SystemProjectRow, 'state' | 'sheets' | 'wanted'>): string {
  if (row.state === 'none') return 'Not drawn yet';
  if (row.state === 'drawing') return `Drawing ${row.sheets} of ${row.sheets + row.wanted}`;
  if (row.state === 'broken') return 'Needs a redraw';
  return plural(row.sheets, 'sheet');
}

export interface SystemProjectsState {
  projects: SystemProjectRow[] | null;
  error: string | null;
  reload: () => void;
}

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
