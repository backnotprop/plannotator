/**
 * The Spaces page's home (approvals "inbox-plans", "plans-home"): while the plans are read, a quiet line; before any
 * plan is here (and from Start a plan), the get-started screen; then the home itself (SpacesHome.tsx).
 */
import { writeRoute } from '../app/writeRoute';
import { PlansGetStarted } from './PlansGetStarted';
import { SpacesHome, type SpacesScope } from './SpacesHome';
import { readPlans, usePlansPage } from './store';
import { ImportErrorNote, PlansMessage } from './parts';
import type { SpacesScopeProject } from './spacesModel';

export function PlansHome({ showStart, scope = { kind: 'home' }, projects = [] }: { showStart: boolean; scope?: SpacesScope; projects?: readonly SpacesScopeProject[] }) {
  const snap = usePlansPage();
  if (snap.off) return <PlansMessage title="Spaces is off" body="Its plans stay on this computer." onBack={() => writeRoute({ page: 'inbox', project: null, thread: null })} backLabel="Inbox" />;
  if (!snap.plans) {
    if (snap.error) return <PlansMessage title="Spaces could not be read" body={snap.error} onRetry={() => void readPlans()} />;
    return <PlansMessage busy title="Spaces" body="Loading plans…" />;
  }
  if (snap.plans.length === 0 || showStart) {
    return (
      <PlansGetStarted
        importing={snap.importing && snap.plans.length === 0}
        note={snap.importError && !snap.importing ? <ImportErrorNote error={snap.importError} onRetry={() => void readPlans(true)} /> : undefined}
        onBack={snap.plans.length > 0 ? () => writeRoute({ page: 'plans', project: null, thread: null }) : undefined}
      />
    );
  }
  return <SpacesHome plans={snap.plans} pins={snap.pins} view={snap.view ?? 'cards'} scope={scope} projects={projects} importing={snap.importing} error={snap.error} importError={snap.importing ? null : snap.importError} />;
}
