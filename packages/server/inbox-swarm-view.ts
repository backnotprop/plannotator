/**
 * Swarm mode (docs/agent-guides/inbox-compose.md, "Swarm"): the view of one thread's agents, for the `swarm` action
 * (inbox-mcp-swarm.ts) and the window. Who is in it: the thread's participants (`store.participantsOf`: the root's
 * `to`, every agent that wrote, every session the person tagged), then any session that said a line there without
 * being one. Each one's state comes from the agents list the window reads (`inboxAgentsGroup`, this computer's group
 * first, then each linked computer's), its line from the thread's swarm record (`InboxSwarms`); the member itself is
 * worked out by `inboxSwarmMembers` (@plannotator/core/inbox-swarm), the same for every reader.
 */

import { INBOX_HOST_NAMES, type InboxAgent, type InboxAgentsGroup } from "@plannotator/core/inbox-types";
import { inboxSwarmMembers, type InboxSwarmMember, type InboxSwarmMemberInput } from "@plannotator/core/inbox-swarm";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxSwarms } from "@plannotator/shared/inbox/swarms";

export interface InboxSwarmView {
  thread_id: string;
  /** The person's switch; false for a thread that never was a swarm. */
  on: boolean;
  members: InboxSwarmMember[];
}

export interface InboxSwarmViewDeps {
  store: InboxStore;
  swarms: InboxSwarms;
  /** The agents the window lists: this computer's group first (its `machine` absent or `selfMachine`), then each linked computer's. */
  agents?: () => readonly InboxAgentsGroup[];
  /** This computer's machine id, when computers are linked. */
  selfMachine?: () => string | null;
  /** A linked computer's name, as this Inbox calls it. */
  machineName?: (machine: string) => string | null;
}

/** An agent the list names for a session: its session now, its launch's id, or a session its conversation continues. */
const isSession = (agent: InboxAgent, session: string) => agent.session === session || agent.id === session || (agent.continues?.includes(session) ?? false);

const hostName = (host: string | null) => (host ? (INBOX_HOST_NAMES[host] ?? host) : null);

export function createInboxSwarmView(deps: InboxSwarmViewDeps) {
  /** The thread's view, or null for a thread this Inbox does not hold. */
  const swarmViewOf = (threadId: string): InboxSwarmView | null => {
    const thread = deps.store.thread(threadId);
    if (!thread) return null;
    const swarm = deps.swarms.get(threadId);
    const participants = deps.store.participantsOf(thread.messages);
    // A session that said a line here without writing or being picked is in the view too: what it said is shown.
    for (const said of swarm?.doing ?? []) {
      if (!participants.some((p) => p.session === said.session)) participants.push({ host: null, session: said.session });
    }
    const groups = deps.agents?.() ?? [];
    const self = deps.selfMachine?.() ?? null;
    const inputs: InboxSwarmMemberInput[] = participants.map((participant) => {
      let found: { agent: InboxAgent; group: InboxAgentsGroup } | null = null;
      for (const group of groups) {
        const agent = group.agents.find((candidate) => isSession(candidate, participant.session));
        if (agent) {
          found = { agent, group };
          break;
        }
      }
      const own = groups[0];
      const far = found && found.group !== own && found.group.machine && found.group.machine !== self ? found.group.machine : null;
      const host = participant.host ?? found?.agent.host ?? null;
      const agent = found?.agent ?? null;
      const project = agent?.project?.name ?? null;
      const computer = far ? (deps.machineName?.(far) ?? null) : null;
      return {
        machine: far,
        host,
        session: participant.session,
        name: agent?.label || agent?.title || hostName(host) || participant.name || "An agent",
        where: project && computer ? `${project} · ${computer}` : (project ?? computer),
        agent,
        // Not found where this computer lists every agent: it has ended. Past the list's cap, or with no list, unknown.
        listed: !!own && own.agents.length >= own.total,
      };
    });
    return { thread_id: threadId, on: swarm?.on ?? false, members: inboxSwarmMembers(inputs, swarm) };
  };
  return { swarmViewOf };
}
