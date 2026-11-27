/**
 * The agent's card atop a list filtered to one agent (approval "inbox-agent-profile-card", A1, A4-A6, D1, E1): its
 * face, its name, "Claude Code · harbor" (and the computer, when it is the other one; when space runs out the project is
 * cut first, the computer's name stays whole: D1), then its line (AgentLine.tsx).
 * A press opens its profile in the reading pane; pressed again, or with the profile open, it closes it. No fill at
 * rest, the hover fill, the selection's fill while its profile is open.
 *
 * `AgentCardSlot` is what the list draws: nothing unless the list is filtered to an agent (nav.tsx), so a list that
 * is not draws no card and reads nothing.
 */
import { memo, useMemo } from 'react';
import { Icon } from '../icons';
import { AgentMark } from '../agents/AgentMark';
import { useInboxAgents } from '../agentsList';
import type { MachinesModel } from '../machines';
import { agentLineOf, lineFactsOf } from './line';
import { AgentLine } from './AgentLine';
import { agentPicks, agentSubParts, profileAgentOf } from './model';
import { useAgentProfileNav } from './nav';

interface AgentCardProps {
  id: string;
  machines: MachinesModel;
  pressed: boolean;
  onToggle: (id: string) => void;
}

const AgentCard = memo(function AgentCard({ id, machines, pressed, onToggle }: AgentCardProps) {
  const groups = useInboxAgents();
  const who = useMemo(() => profileAgentOf(id, groups, machines), [id, groups, machines]);
  if (!who) return null;
  const line = agentLineOf(lineFactsOf(who.agent));
  const sub = agentSubParts(who, machines);
  return (
    <div className="ib-apc" data-agent-card={id} data-agent-card-line={line ? line.tone : 'none'}>
      <AgentMark id={who.agent.id} host={who.agent.host} name={who.name} agent={who.agent} picks={agentPicks(who.machine, machines)} size={44} />
      <button type="button" className="ib-apc-b" aria-pressed={pressed} data-agent-profile-opener={id} onClick={() => onToggle(id)}>
        <span className="ib-apc-1">
          <span className="ib-apc-n" dir="auto">
            {who.name}
          </span>
          <span className="ib-apc-m">
            <span className="ib-apc-h">{sub.host}</span>
            {sub.project && (
              <span className="ib-apc-p" dir="auto">
                {' · '}
                {sub.project}
              </span>
            )}
            {sub.machine && (
              <span className="ib-apc-k" dir="auto">
                {' · '}
                {sub.machine}
              </span>
            )}
          </span>
        </span>
        {line && (
          <span className="ib-apc-2">
            <AgentLine line={line} />
          </span>
        )}
        <Icon name="chevR" size={16} className="ib-apc-go" />
      </button>
    </div>
  );
});

/** The card for the agent the list is filtered to, or nothing. `hidden`: the Agents view, whose agent row is the card. */
export function AgentCardSlot({ hidden = false }: { hidden?: boolean }) {
  const nav = useAgentProfileNav();
  if (!nav?.filter || hidden) return null;
  return <AgentCard id={nav.filter} machines={nav.machines} pressed={nav.open === nav.filter} onToggle={nav.toggle} />;
}
