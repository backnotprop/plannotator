import type { InboxExperimentalSettings } from '../api';
import { Switch } from '../components/SoundRow';

/**
 * Settings → Capabilities → Experimental → Swarm (docs/agent-guides/inbox-swarm.md), after Grid: one set across linked
 * computers, like every switch there. Locked while PLANNOTATOR_EXPERIMENTAL decides it, which its words then say.
 * The words are the owner's, approved 2026-11-25 (`.product/approved/inbox-swarm-settings-row`).
 * Nothing while the Inbox reports no Swarm or Settings has no switch to give it (as Grid's row beside it).
 */
export function SwarmSettingsRow({
  experimental,
  onToggleExperimental,
}: {
  experimental: InboxExperimentalSettings | null;
  onToggleExperimental?: (next: boolean, feature?: 'grid' | 'swarm') => void;
}) {
  const value = experimental?.swarm;
  if (!value || !onToggleExperimental) return null;
  const onToggle = (next: boolean) => onToggleExperimental(next, 'swarm');
  return (
    <div className="ib-prow" data-settings-swarm="">
      <span className="ib-txt">
        <span className="ib-l" id="ib-swarm-label">Swarm</span>
        <span className="ib-desc">
          {value.env !== null ? `PLANNOTATOR_EXPERIMENTAL turns it ${value.env ? 'on' : 'off'}.` : 'Several agents work one thread as a team, and talk to each other in its ghost thread.'}
        </span>
      </span>
      <span className="ib-ctl">
        <Switch on={value.on} labelledBy="ib-swarm-label" disabled={value.env !== null} onClick={() => onToggle(!value.on)} />
      </span>
    </div>
  );
}
