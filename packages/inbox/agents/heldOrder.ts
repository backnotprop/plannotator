import { useRef } from 'react';
import type { AgentsGroup } from './model';

/**
 * With "Show agent status" on, the Agents list puts waiting agents first (model.ts `sortAgentEntries`). While the
 * pointer is on the list, a row never moves: an agent that starts waiting would otherwise slide another row under a
 * click. Each group keeps the order it was drawn in, a new agent joins at its group's end, a gone one leaves; every
 * row still shows its own state. The pointer leaving lets the list take its order.
 */
export function holdAgentOrder(drawn: readonly AgentsGroup[] | null, next: readonly AgentsGroup[]): AgentsGroup[] {
  if (!drawn) return [...next];
  const before = new Map(drawn.map((group) => [group.machine?.id ?? 'flat', group.agents.map((entry) => entry.agent.id)] as const));
  return next.map((group) => {
    const order = before.get(group.machine?.id ?? 'flat');
    if (!order) return group;
    const place = new Map(order.map((id, index) => [id, index] as const));
    const kept = group.agents.filter((entry) => place.has(entry.agent.id)).sort((a, b) => place.get(a.agent.id)! - place.get(b.agent.id)!);
    const added = group.agents.filter((entry) => !place.has(entry.agent.id));
    return { ...group, agents: [...kept, ...added] };
  });
}

/** The groups as drawn: held in their last drawn order while `hold`. */
export function useHeldAgentOrder(groups: AgentsGroup[], hold: boolean): AgentsGroup[] {
  const drawn = useRef<AgentsGroup[] | null>(null);
  const shown = hold ? holdAgentOrder(drawn.current, groups) : groups;
  drawn.current = shown;
  return shown;
}
