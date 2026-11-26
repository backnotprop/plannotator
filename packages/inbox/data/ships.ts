/**
 * Ship (approval "inbox-ship-mode"): the window's side of packages/server/inbox-ship-routes.ts. A ship's record lives
 * on the computer whose Inbox holds the shipping agent's thread, so a ship on a linked machine is read, started and
 * stopped there (`inboxUrl`'s forward). The window reads this Inbox's ships and every linked machine's that takes
 * them (its `ships` mark): a Reviews row shows ship mode whichever computer ships its pull request, and Ship's list
 * offers every computer's agents. `event: ships` from this Inbox says its ships changed (eventFrames.ts emits it here,
 * as `event: runs`); a linked machine's are read again with the Reviews list, on focus, and while one is active.
 *
 * One read per computer at a time, kept for the window: the Reviews list and an open thread draw from the same reads.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { InboxShipLogEntry, InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { shipActive } from '@plannotator/core/inbox-pull-handoff';
import { apiGet, apiPost } from '../api';
import { inboxUrl, linkedMachinesRev, linkedMachinesWith, onLinkedMachines } from '../inboxUrl';
import { newUuid } from '../uuid';
import { shipEvents } from './shipEvents';

export { shipEvents };

export type ShipTo = { host: string; session: string } | { launch: { agent: string; project_id: string; model?: string; effort?: string } };

/** One computer's ships, and its projects by repository (`host/repo` → ids): who on it can take a PR's ship. */
export interface MachineShips {
  ships: InboxShipView[];
  projects: Readonly<Record<string, string[]>>;
}

/** A linked machine's ships carry `machine`; this Inbox's none. */
export async function readShips(machine: string | null): Promise<MachineShips> {
  const got = await apiGet<{ ships?: InboxShipView[]; projects?: Record<string, string[]> }>(inboxUrl('/ships', undefined, machine));
  return { ships: (got.ships ?? []).map((ship) => (machine ? { ...ship, machine } : ship)), projects: got.projects ?? {} };
}

export async function readShipLog(id: string, machine: string | null): Promise<{ ship: InboxShipView; log: InboxShipLogEntry[] }> {
  return apiGet(inboxUrl('/ships/log', `id=${encodeURIComponent(id)}`, machine));
}

/**
 * Ship on `machine` (null: this computer): the instruction to `to` in the thread, or (`started`) only the record of a
 * thread the window just started with it there (`to`: who it started it with).
 */
export async function startShip(input: { key: string; thread_id: string; to?: ShipTo; started?: true }, machine: string | null): Promise<InboxShipView> {
  const got = await apiPost<{ ship: InboxShipView }>(inboxUrl('/ships', undefined, machine), { ...input, idempotency_key: newUuid() });
  shipsChanged(machine);
  return machine ? { ...got.ship, machine } : got.ship;
}

export async function stopShip(id: string, machine: string | null): Promise<InboxShipView> {
  const got = await apiPost<{ ship: InboxShipView }>(inboxUrl('/ships/stop', undefined, machine), { id });
  shipsChanged(machine);
  return got.ship;
}

/** A linked machine with a ship going is read again this often while the window is shown (its stream is not this one). */
export const SHIP_FAR_READ_MS = 60_000;
/** A read this recent is not asked for again by another view opening (a press, an event or focus always reads). */
const SHIP_FRESH_MS = 5_000;

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

// The window's reads, by computer ('' is this one).
const kept = new Map<string, MachineShips>();
const readAt = new Map<string, number>();
const reading = new Map<string, { again: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Read `machine`'s ships, unless a read of it is under way (then once more after it) or fresh and not `force`d. */
export function readShipsOf(machine: string | null, force: boolean): void {
  const key = machine ?? '';
  const now = reading.get(key);
  if (now) {
    if (force) now.again = true;
    return;
  }
  if (!force && Date.now() - (readAt.get(key) ?? 0) < SHIP_FRESH_MS) return;
  const mine = { again: false };
  reading.set(key, mine);
  readShips(machine)
    .then(
      (got) => {
        kept.set(key, got);
        readAt.set(key, Date.now());
        notify();
      },
      () => {},
    )
    .finally(() => {
      reading.delete(key);
      if (mine.again) readShipsOf(machine, true);
    });
}

/** A press here changed `machine`'s ships: read them again, and tell this Inbox's views (`event: ships` does too). */
function shipsChanged(machine: string | null) {
  if (machine) readShipsOf(machine, true);
  shipEvents.emit();
}

/** What a computer's last read said, or null before one landed. */
export function shipsOf(machine: string | null): MachineShips | null {
  return kept.get(machine ?? '') ?? null;
}

/** Tests only: forget every read. */
export function resetShipsForTests(): void {
  kept.clear();
  readAt.clear();
  reading.clear();
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const NONE: ReadonlyMap<string, InboxShipView> = new Map();

/**
 * The ships the window draws, by pull request key: this Inbox's, and each linked machine's in `machines`. Read while
 * `enabled`, when `poke` changes (each Reviews read), on `event: ships` and on focus; nothing at all while off.
 */
export function useShips(enabled: boolean, machines: readonly string[], poke: unknown): ReadonlyMap<string, InboxShipView> {
  const asked = machines.join('\n');
  const latest = useRef(machines);
  latest.current = machines;
  const seen = useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => {
    if (!enabled) return;
    const all = (force: boolean) => {
      readShipsOf(null, force);
      for (const machine of latest.current) readShipsOf(machine, force);
    };
    all(false);
    const off = shipEvents.subscribe(() => readShipsOf(null, true));
    const shown = () => {
      if (document.visibilityState === 'visible') all(true);
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      off();
      document.removeEventListener('visibilitychange', shown);
    };
  }, [enabled, asked, poke]);
  const farActive = enabled && machines.some((machine) => shipsOf(machine)?.ships.some(shipActive));
  useEffect(() => {
    if (!farActive) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const machine of latest.current) readShipsOf(machine, true);
    }, SHIP_FAR_READ_MS);
    return () => clearInterval(timer);
  }, [farActive]);
  return useMemo(() => {
    if (!enabled) return NONE;
    const lists = [null, ...machines].flatMap((machine) => shipsOf(machine)?.ships ?? []);
    return lists.length === 0 ? NONE : shipsByPull([lists]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, seen, asked]);
}

/** The linked machines that take ships (their `ships` mark), as the merged list says them now; again when it changes. */
export function useShipTakers(): readonly string[] {
  const rev = useSyncExternalStore(onLinkedMachines, linkedMachinesRev, () => 0);
  return useMemo(() => linkedMachinesWith('ships'), [rev]);
}

/** Bumps on every read that landed: for what derives from the reads besides the ships (a computer's projects). */
export function useShipsSeen(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
