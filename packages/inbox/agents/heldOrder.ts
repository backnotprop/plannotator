import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentsGroup } from './model';

/**
 * With "Show agent status" on, the Agents list puts waiting agents first (model.ts `sortAgentEntries`). While the
 * pointer is on the list, a row never moves: an agent that starts waiting would otherwise slide another row under a
 * click. Each group keeps the order it was drawn in, a new agent joins at its group's end, a gone one leaves; every
 * row still shows its own state. Letting go ({@link useAgentOrderHold}) lets the list take its order.
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

/** The longest the order stays held with the pointer resting still on the list. */
export const AGENT_ORDER_HOLD_MS = 4_000;

/**
 * Whether the list holds its order, and the pointer handlers that decide it: the pointer on the list holds, moving on
 * it holds again for {@link AGENT_ORDER_HOLD_MS}, and leaving it, the window losing focus, the tab hidden or that
 * long without a move lets go. Someone who switches apps with the keyboard while the mouse rests on the list still
 * sees a newly waiting agent move up.
 */
export function useAgentOrderHold() {
  const [hold, setHold] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const release = useCallback(() => {
    stopTimer();
    setHold(false);
  }, [stopTimer]);
  const touch = useCallback(() => {
    stopTimer();
    setHold(true);
    timer.current = setTimeout(release, AGENT_ORDER_HOLD_MS);
  }, [stopTimer, release]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimer();
    };
  }, [release, stopTimer]);
  return { hold, onPointerEnter: touch, onPointerMove: touch, onPointerLeave: release };
}

/** The groups as drawn: held in their last drawn order while `hold`. */
export function useHeldAgentOrder(groups: AgentsGroup[], hold: boolean): AgentsGroup[] {
  const drawn = useRef<AgentsGroup[] | null>(null);
  const shown = hold ? holdAgentOrder(drawn.current, groups) : groups;
  drawn.current = shown;
  return shown;
}
