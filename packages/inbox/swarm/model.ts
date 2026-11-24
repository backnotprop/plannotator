import type { InboxAgent, InboxAgentsGroup, InboxSwarm } from '@plannotator/core/inbox-types';
import { inboxSwarmMembers, type InboxSwarmMember } from '@plannotator/core/inbox-swarm';
import type { ThreadSession } from '../agents/model';

/**
 * Whether agents on other linked computers can work in a thread made on one computer: tagged there, woken on their own
 * computer, and able to read and reply into it. False until the "tag any agent into a thread on another linked
 * computer" work ships that, which turns this on. The one switch for it (swarmCanJoin).
 */
export const SWARM_ACROSS_COMPUTERS = false;

/**
 * Can an agent on the computer `candidate` (To's machine key) work in a thread made on the first pick's computer
 * (`first`, null while To has no first pick)? The ONE rule New message's Add an agent uses: today the first pick's own
 * computer only; every computer once `across` is on.
 */
export function swarmCanJoin(first: string | null, candidate: string, across: boolean = SWARM_ACROSS_COMPUTERS): boolean {
  return across || first === null || candidate === first;
}

/**
 * A swarm thread's members in the window: its sessions (the thread header's `threadSessions`, one per agent), each
 * with its listed agent from the merged agents list (its state, last word, activity: the live connection) and its own
 * line from the thread's swarm record. `machineNames`: a linked computer's name by id, for "ledger · Mac mini";
 * `self`: this computer's id.
 */
export function swarmMembersOf(
  sessions: readonly ThreadSession[],
  groups: readonly InboxAgentsGroup[] | null,
  swarm: Pick<InboxSwarm, 'doing'> | null,
  machineNames: ReadonlyMap<string, string>,
  self: string | null,
): InboxSwarmMember[] {
  const flat: (InboxAgent & { machine: string | null })[] = (groups ?? []).flatMap((g) => g.agents.map((a) => ({ ...a, machine: g.machine ?? null })));
  // One agent may have written under several session ids: its newest line stands for it, under its first id.
  const doing = swarm
    ? sessions.flatMap((s) => {
        const said = swarm.doing.filter((d) => s.sessions.includes(d.session)).sort((a, b) => b.at.localeCompare(a.at))[0];
        return said ? [{ ...said, session: s.session }] : [];
      })
    : [];
  return inboxSwarmMembers(
    sessions.map((s) => {
      const agent = s.agentId ? (flat.find((a) => a.id === s.agentId && (a.machine ?? null) === (s.machine ?? null)) ?? null) : null;
      const other = s.machine && s.machine !== self ? (machineNames.get(s.machine) ?? null) : null;
      const where = [agent?.project?.name, other].filter(Boolean).join(' · ') || null;
      return { machine: s.machine, host: s.host, session: s.session, name: s.name, where, agent, listed: s.state !== null };
    }),
    { doing },
  );
}
