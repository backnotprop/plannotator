/**
 * Reviews' Ship (approval "inbox-ship-mode"), for PullsPage: the ships its rows draw (this computer's, and each linked
 * machine's that takes ships or holds a row's thread), the menu's handlers, and the ship log by its row. Code review's
 * page only: nothing reads or draws while it is not shown.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shipTurnedMerged } from './shipMergedRead';
import { shipActive, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import type { InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { machineOf } from '../inboxUrl';
import type { InboxToastModel } from '../components/Toast';
import { errorToast } from '../toastError';
import { stopShip, useShips, useShipsSeen, useShipTakers } from '../data/ships';
import { shipProjectsOf, shipPull } from './shipStart';
import { ShipLog, ShipLogBody } from './ShipLog';
import type { ShipHandlers } from './ReviewsList';

/** The linked machines whose ships are read too: each that takes ships, and each that holds a Reviews row's thread. */
export function shipMachines(answer: InboxReviewsAnswer | null, takers: readonly string[] = []): string[] {
  const out = new Set<string>(takers);
  for (const row of answer?.rows ?? []) {
    const thread = row.thread_id ?? row.link?.thread_id ?? null;
    const machine = thread ? machineOf(thread) : null;
    if (machine) out.add(machine);
  }
  return [...out].sort();
}

export function useShipping(answer: InboxReviewsAnswer | null, phone: boolean, onToast?: (toast: Omit<InboxToastModel, 'id'>, ms: number) => void, onMerged?: () => void): { ships: ReadonlyMap<string, InboxShipView>; handlers: ShipHandlers; log: ReactNode } {
  const takers = useShipTakers();
  const machines = useMemo(() => shipMachines(answer, takers), [answer, takers]);
  const ships = useShips(true, machines, answer);
  // A ship turned merged: Reviews once more now (shipMergedRead.ts).
  const before = useRef(ships);
  const merged = useRef(onMerged);
  merged.current = onMerged;
  useEffect(() => {
    if (shipTurnedMerged(before.current, ships)) merged.current?.();
    before.current = ships;
  }, [ships]);
  const [open, setOpen] = useState<{ ship: InboxShipView; anchor: HTMLElement | null } | null>(null);
  const fail = (cause: unknown, fallback: string) => onToast?.(errorToast(cause, fallback), 8000);
  const stop = (ship: InboxShipView) => {
    stopShip(ship.id, ship.machine ?? null).catch((cause) => fail(cause, 'Shipping didn’t stop. Try again.'));
  };
  const local = answer?.projects;
  const seen = useShipsSeen();
  const projectsOf = useMemo(() => shipProjectsOf(local ?? {}), [local, seen]);
  const handlers: ShipHandlers = {
    ships,
    repoProjects: answer?.projects ?? {},
    projectsOf,
    onShip: (target, option) => {
      // One ship per pull request: the Inbox that starts it tells every linked computer (server inbox-ship-watch.ts
      // `onStart`, through the outbox), and an older ship of it there stops, whether or not this window read it.
      shipPull(target, option, option.group).catch((cause) => fail(cause, 'Ship didn’t start. Try again.'));
    },
    onLog: (ship, anchor) => setOpen({ ship, anchor }),
    onStop: stop,
  };
  // The open log follows its ship as it changes.
  const shown = open ? (ships.get(open.ship.key) ?? open.ship) : null;
  const log = <ShipLog ship={shown} anchor={open?.anchor ?? null} phone={phone} onStop={stop} onClose={() => setOpen(null)} />;
  return { ships, handlers, log };
}

/** Reviews' ships, for the PR's own page (`PageShipLog`). */
export const ShipsContext = createContext<Pick<ShipHandlers, 'ships' | 'onStop'> | null>(null);

/** The review page's ship log, with Stop, while its pull request ships. */
export function PageShipLog({ pullKey }: { pullKey: string }) {
  const given = useContext(ShipsContext);
  const ship = given?.ships.get(pullKey) ?? null;
  if (!given || !ship || !shipActive(ship)) return null;
  return (
    <div className="ib-shp-onpage" data-ship-page={ship.id}>
      <ShipLogBody ship={ship} onStop={() => given.onStop(ship)} />
    </div>
  );
}
