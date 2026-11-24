/**
 * Ship (approval "inbox-ship-mode"): the window's side of packages/server/inbox-ship-routes.ts. A ship's record lives
 * on the computer whose Inbox holds the shipping agent's thread, so a review thread on a linked machine ships there and
 * is read from there (`inboxUrl`'s forward). `event: ships` from this Inbox says its ships changed (eventFrames.ts
 * emits it here, as `event: runs`); a linked machine's are read again with the Reviews list and while one is active.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxShipLogEntry, InboxShipView } from '@plannotator/core/inbox-ship';
import { shipActive } from '@plannotator/core/inbox-ship';
import { apiGet, apiPost } from '../api';
import { inboxUrl } from '../inboxUrl';
import { newUuid } from '../uuid';
import { shipEvents } from './shipEvents';

export { shipEvents };

export type ShipTo = { host: string; session: string } | { launch: { agent: string; project_id: string; model?: string; effort?: string } };

/** A linked machine's ships carry `machine`; this Inbox's none. */
export async function readShips(machine: string | null): Promise<InboxShipView[]> {
  const got = await apiGet<{ ships: InboxShipView[] }>(inboxUrl('/ships', undefined, machine));
  return (got.ships ?? []).map((ship) => (machine ? { ...ship, machine } : ship));
}

export async function readShipLog(id: string, machine: string | null): Promise<{ ship: InboxShipView; log: InboxShipLogEntry[] }> {
  return apiGet(inboxUrl('/ships/log', `id=${encodeURIComponent(id)}`, machine));
}

/** Ship: the instruction to `to` in the thread, or (`started`) only the record of a thread the window just started. */
export async function startShip(input: { key: string; thread_id: string; to?: ShipTo; started?: true }, machine: string | null): Promise<InboxShipView> {
  const got = await apiPost<{ ship: InboxShipView }>(inboxUrl('/ships', undefined, machine), { ...input, idempotency_key: newUuid() });
  shipEvents.emit();
  return machine ? { ...got.ship, machine } : got.ship;
}

export async function stopShip(id: string, machine: string | null): Promise<InboxShipView> {
  const got = await apiPost<{ ship: InboxShipView }>(inboxUrl('/ships/stop', undefined, machine), { id });
  shipEvents.emit();
  return got.ship;
}

/** A linked machine with a ship going is read again this often while the window is shown (its stream is not this one). */
export const SHIP_FAR_READ_MS = 60_000;

/** One ship per pull request: an active one over an ended one, then the newest. */
export function shipsByPull(lists: readonly (readonly InboxShipView[])[]): Map<string, InboxShipView> {
  const out = new Map<string, InboxShipView>();
  for (const ship of lists.flat()) {
    const was = out.get(ship.key);
    const better = !was || (shipActive(ship) && !shipActive(was)) || (shipActive(ship) === shipActive(was) && ship.started_at > was.started_at);
    if (better) out.set(ship.key, ship);
  }
  return out;
}

const NONE: ReadonlyMap<string, InboxShipView> = new Map();

/**
 * The ships the Reviews rows draw, by pull request key: this Inbox's, and each linked machine's in `machines` (the
 * machines that hold a row's thread). Read while `enabled`, when `poke` changes (each Reviews read), on `event: ships`
 * and on focus; nothing at all while off.
 */
export function useShips(enabled: boolean, machines: readonly string[], poke: unknown): ReadonlyMap<string, InboxShipView> {
  const [lists, setLists] = useState<Readonly<Record<string, readonly InboxShipView[]>>>({});
  const asked = machines.join('\n');
  const latest = useRef({ enabled, machines });
  latest.current = { enabled, machines };
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const read = (machine: string | null) => {
      readShips(machine).then(
        (ships) => {
          if (!gone) setLists((was) => ({ ...was, [machine ?? '']: ships }));
        },
        () => {},
      );
    };
    const all = () => {
      read(null);
      for (const machine of latest.current.machines) read(machine);
    };
    all();
    const off = shipEvents.subscribe(() => read(null));
    const shown = () => {
      if (document.visibilityState === 'visible') all();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      gone = true;
      off();
      document.removeEventListener('visibilitychange', shown);
    };
  }, [enabled, asked, poke]);
  const farActive = Object.entries(lists).some(([machine, ships]) => machine !== '' && ships.some(shipActive));
  useEffect(() => {
    if (!enabled || !farActive) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const machine of latest.current.machines) {
        readShips(machine).then(
          (ships) => setLists((was) => ({ ...was, [machine]: ships })),
          () => {},
        );
      }
    }, SHIP_FAR_READ_MS);
    return () => clearInterval(timer);
  }, [enabled, farActive]);
  return useMemo(() => {
    if (!enabled) return NONE;
    const kept = Object.entries(lists).filter(([machine]) => machine === '' || machines.includes(machine));
    return kept.length === 0 ? NONE : shipsByPull(kept.map(([, ships]) => ships));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, lists, asked]);
}
