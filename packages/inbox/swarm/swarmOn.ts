/**
 * Swarm's switch in the window (docs/agent-guides/inbox-swarm.md): experimental, off by default; Settings → Capabilities
 * → Experimental turns it (one set across linked computers), as do config.json `experimental.swarm` and
 * PLANNOTATOR_EXPERIMENTAL=swarm. The settings read says it (`experimental.swarm`); App adopts it here and every swarm
 * piece reads it: New message's other agents and Swarm badge, a swarm thread's summary row, its Ghost button, its ghost
 * pane and its plan card. Off, none of them draws, and the window is as it was. A turn reads the skill catalog again,
 * which has `/swarm` only while it is on (the words Send pastes for the badge).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import type { SettingsModel } from '../api';

let on = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What the Inbox says now (App, from each settings read). */
export function adoptSwarmOn(next: boolean): void {
  if (next === on) return;
  on = next;
  reloadSkillCatalog();
  for (const listener of listeners) listener();
}

/** App: the settings read's switch, adopted after the draw. */
export function useSwarmOn(settings: Pick<SettingsModel, 'experimental'> | null): boolean {
  const next = settings?.experimental?.swarm?.on === true;
  useEffect(() => adoptSwarmOn(next), [next]);
  return next;
}

/** Whether Swarm is on, for any piece of the window. */
export function useSwarmSwitch(): boolean {
  return useSyncExternalStore(subscribe, () => on, () => false);
}
