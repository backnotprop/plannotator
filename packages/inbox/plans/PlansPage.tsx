/**
 * The sidebar's Spaces page (docs/agent-guides/inbox-plans.md), drawn only while Plans is on (config.json
 * `inboxPlans`, present in the settings only then). Off, nothing of it shows: a `#plans` link goes to the Inbox in
 * place, as a `#shapes` link does with Shape off.
 */
import { useEffect } from 'react';
import type { Route } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import { PlansHome } from './PlansHome';
import { PlanPage } from './PlanPage';
import type { SpacesScopeProject } from './spacesModel';

export { usePlansOn } from './store';

export function PlansRoute({ route, on, settingsKnown, phone, projects = [] }: { route: Route; on: boolean; settingsKnown: boolean; phone: boolean; projects?: readonly SpacesScopeProject[] }) {
  useEffect(() => {
    if (settingsKnown && !on) writeRoute({ page: 'inbox', project: null, thread: null }, { replace: true });
  }, [settingsKnown, on]);
  if (!on) return <section className="ib-dpage" aria-busy={!settingsKnown || undefined} data-plans-waiting="" />;
  if (route.plan) return <PlanPage key={route.plan} id={route.plan} version={route.planVersion ?? null} diff={route.planDiff ?? null} phone={phone} doc={route.planDoc ?? null} file={route.planFile ?? null} />;
  const scope = route.project ? ({ kind: 'project', id: route.project } as const) : route.planAll ? ({ kind: 'all' } as const) : ({ kind: 'home' } as const);
  return <PlansHome showStart={route.planNew === true} scope={scope} projects={projects} />;
}
