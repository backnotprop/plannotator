/**
 * A project that was combined (here, in another window, by an agent) has no page of its own: its link opens the
 * project it went into (App).
 */
import { useEffect } from 'react';
import type { Route } from './route';
import { writeRoute } from './writeRoute';

export function useCombinedHead(route: Route, projects: readonly { id: string; combined?: readonly { id: string }[] | null }[]): void {
  const combinedHead = route.project ? projects.find((project) => project.combined?.some((member) => member.id === route.project))?.id : undefined;
  useEffect(() => {
    if (combinedHead) writeRoute({ ...route, project: combinedHead }, { replace: true });
  }, [combinedHead]);
}
