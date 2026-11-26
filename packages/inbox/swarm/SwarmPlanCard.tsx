import { useState, type ReactNode } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { InboxSwarmPlan, InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { HostMark, Icon } from '../icons';
import { inboxAgentsFlat, useInboxAgents } from '../agentsList';
import { linkedMachineFacts, machineOf, selfMachineName } from '../inboxUrl';
import { whenTime } from '../format';
import { SwarmGlyph } from './SwarmBadge';
import { GhostGlyph } from './GhostGlyph';
import { useSharedThreadSwarm } from './swarmThreadShare';
import { SWARM_PLAN_FOLD_AFTER, SWARM_PLAN_FOLD_SHOWN, swarmPlanCountWords, swarmPlanRows, swarmPlanStatusWords, type SwarmPlanRow } from './swarmPlanModel';
import { swarmMemberComputer } from './swarmModel';

/**
 * The body of the agent reply `swarm propose` wrote (`InboxMessage.swarm_plan`): the swarm's plan card while Swarm is
 * on and the thread's read has the plan for this message; else the message's own words (`fallback`), as any message.
 */
export function SwarmPlanSlot({ message, fallback }: { message: InboxMessageWire; fallback: ReactNode }) {
  const shared = useSharedThreadSwarm(message.thread_id);
  const plan = shared?.swarm.plan ?? null;
  if (!shared || !plan || plan.message_id !== message.id) return <>{fallback}</>;
  const writer = message.author.kind === 'agent' ? (message.author.name ?? null) : null;
  return <SwarmPlanCard threadId={message.thread_id} plan={plan} swarm={shared.swarm} writer={writer} onGhost={shared.openGhost} />;
}

/**
 * The plan card (approval "inbox-swarm-thread-ui": head H1, "the swarm band"; body the "Now / after" take, P2, here
 * without its groups): the agent's first reply to the swarm message. The band: the Swarm mark, "Swarm plan", one calm
 * line that work has started (and who is still joining), the count of parts; never the team's marks, so 20 agents read
 * as well as 2. Then the plan in a line, and each part: what it does, and who does it (its mark, its name, where it
 * runs; an agent still being brought in "joining", its mark's tile dashed; a sub-agent under the agent it works for).
 * A long team folds after SWARM_PLAN_FOLD_AFTER rows. It starts right away: no Go, and in this piece no change controls
 * (Change plan comes later). It follows every read of the thread (an agent joining, a line changed, another agent's
 * part added) in place: one card, never a second.
 */
export function SwarmPlanCard({ threadId, plan, swarm, writer, onGhost }: { threadId: string; plan: InboxSwarmPlan; swarm: InboxThreadSwarm; writer: string | null; onGhost?: () => void }) {
  const agents = inboxAgentsFlat(useInboxAgents());
  const [all, setAll] = useState(false);
  const rows = swarmPlanRows(plan, swarm.members);
  const folds = rows.length > SWARM_PLAN_FOLD_AFTER;
  const shown = folds && !all ? rows.slice(0, SWARM_PLAN_FOLD_SHOWN) : rows;
  const threadMachine = machineOf(threadId);
  /** Where a part's agent runs: its project and its computer, once a member answers to its name. */
  const whereOf = (row: SwarmPlanRow): string | null => {
    if (!row.member) return null;
    const project = agents.find((a) => a.session === row.member!.session)?.project?.name ?? null;
    const computer = swarmMemberComputer(row.member, () => (threadMachine ? (linkedMachineFacts(threadMachine)?.name ?? null) : selfMachineName()));
    return [project, computer].filter(Boolean).join(' · ') || null;
  };
  return (
    <section className="ib-swarm-plan" aria-label="Swarm plan" data-swarm-plan="" data-off={swarm.on ? undefined : ''}>
      <div className="ib-sp-band">
        <span className="ib-sp-mark" aria-hidden="true">
          <SwarmGlyph size={16} />
        </span>
        <span className="ib-sp-title">Swarm plan</span>
        <span className="ib-sp-status" data-swarm-plan-status="">
          {swarmPlanStatusWords(plan, rows, swarm, whenTime)}
        </span>
        <span className="ib-sp-count" data-swarm-plan-count="">
          {swarmPlanCountWords(plan)}
        </span>
      </div>
      {plan.summary && (
        <p className="ib-sp-sum" dir="auto" data-swarm-plan-summary="">
          {plan.summary}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="ib-sp-parts">
          {shown.map((row) => {
            const where = whereOf(row);
            return (
              <li key={row.part.who.toLowerCase()} className="ib-sp-part" data-depth={row.depth} data-joined={row.joined ? '' : undefined} data-swarm-plan-part={row.part.who}>
                <span className="ib-sp-does" dir="auto" data-swarm-plan-does="">
                  {row.part.does}
                </span>
                <span className="ib-sp-who">
                  <span className="ib-sp-mk" data-waiting={row.joined ? undefined : ''}>
                    <HostMark host={row.host} agent={row.member?.session ?? null} />
                  </span>
                  <bdi className="ib-sp-nm">{row.part.who}</bdi>
                  {where && <span className="ib-sp-wh">{where}</span>}
                  {!row.joined && (
                    <span className="ib-sp-state" data-swarm-plan-joining="">
                      {row.sub ? 'sub-agent' : 'joining'}
                    </span>
                  )}
                </span>
                {writer && row.part.by !== writer && (
                  <span className="ib-sp-by" data-swarm-plan-by="">
                    Added by <bdi>{row.part.by}</bdi>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {folds && (
        <button type="button" className="ib-sp-more" aria-expanded={all} onClick={() => setAll((was) => !was)} data-swarm-plan-more="">
          <span>{all ? 'Show fewer' : `Show ${rows.length - SWARM_PLAN_FOLD_SHOWN} more`}</span>
          <Icon name={all ? 'chevU' : 'chevD'} size={13} />
        </button>
      )}
      {onGhost && (
        <div className="ib-sp-foot">
          <button type="button" className="ib-sp-ghost" onClick={onGhost} data-swarm-plan-ghost="">
            <GhostGlyph size={16} />
            <span>Ghost thread</span>
          </button>
        </div>
      )}
    </section>
  );
}
