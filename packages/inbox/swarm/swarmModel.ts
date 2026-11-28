/**
 * A swarm thread's members as the window draws them (the summary row, the status view, the ghost pane's "to"):
 * pure, from the thread read's `swarm` (packages/shared/inbox/swarm.ts `swarmWire`).
 */
import type { InboxMessage } from '@plannotator/core/inbox-types';
import type { InboxSwarmMemberWire, InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';

/** A member's state in words, quiet text (no spinner). Null: not known, nothing is said. */
export function swarmStateWords(member: Pick<InboxSwarmMemberWire, 'joined' | 'state'>): string | null {
  if (!member.joined) return 'not joined yet';
  if (member.state === 'waiting') return 'waiting on you';
  return member.state ?? null;
}

/** The summary row's words: "3 agents · 2 working · 1 waiting on you" (a part with none is left out); "· off" once turned off. */
export function swarmSummaryWords(swarm: Pick<InboxThreadSwarm, 'members' | 'on'>): { count: string; working: string | null; waiting: string | null; off: boolean } {
  const n = swarm.members.length;
  const working = swarm.members.filter((m) => m.joined && m.state === 'working').length;
  const waiting = swarm.members.filter((m) => m.joined && m.state === 'waiting').length;
  return {
    count: `${n} ${n === 1 ? 'agent' : 'agents'}`,
    working: swarm.on && working > 0 ? `${working} working` : null,
    waiting: swarm.on && waiting > 0 ? `${waiting} waiting on you` : null,
    off: !swarm.on,
  };
}

/**
 * The computer a member runs on, as the status view and the plan card name it: its linked computer's (`machine_name`);
 * none when that computer's name is not known (`machine_name: null`), never this computer's; else the thread's computer.
 */
export function swarmMemberComputer(member: Pick<InboxSwarmMemberWire, 'machine_name'>, threadComputer: () => string | null): string | null {
  return member.machine_name !== undefined ? member.machine_name : threadComputer();
}

/** The members in the status view's order: each top-level member, then the sub-agents that work for it (`for`), indented. */
export function swarmMemberTree(members: readonly InboxSwarmMemberWire[]): { member: InboxSwarmMemberWire; depth: 0 | 1 }[] {
  const names = new Set(members.map((m) => m.name.toLowerCase()));
  const parentOf = (m: InboxSwarmMemberWire) => (m.for && names.has(m.for.toLowerCase()) && m.for.toLowerCase() !== m.name.toLowerCase() ? m.for.toLowerCase() : null);
  const out: { member: InboxSwarmMemberWire; depth: 0 | 1 }[] = [];
  for (const top of members.filter((m) => parentOf(m) === null)) {
    out.push({ member: top, depth: 0 });
    for (const sub of members.filter((m) => parentOf(m) === top.name.toLowerCase())) out.push({ member: sub, depth: 1 });
  }
  // A sub-agent whose member works for another sub-agent: under its own line, still indented.
  for (const m of members) if (!out.some((o) => o.member === m)) out.push({ member: m, depth: 1 });
  return out;
}

/** Who a ghost message is to: the one member it names, else everyone (`saySwarm` tags every other member). */
export function ghostToWords(message: Pick<InboxMessage, 'tags'>): string {
  const tags = message.tags ?? [];
  return tags.length === 1 ? (tags[0]!.label ?? tags[0]!.name ?? 'one agent') : 'everyone';
}

/** Who wrote a ghost message. */
export function ghostFromWords(message: Pick<InboxMessage, 'author'>, agentName: (author: InboxMessage['author']) => string): string {
  return message.author.kind === 'person' ? 'You' : agentName(message.author);
}
