/**
 * Ship from the review thread's own view (approval "inbox-ship-mode", item 7): while the thread's pull request ships,
 * the thread's ⋯ menu (CopyMenus.tsx `ThreadMore`) starts with Ship log and Stop shipping, as the Reviews row's menu
 * does, and Ship log opens the same log (newest first, with Stop) by the ⋯ button, or a phone's sheet.
 *
 * Which ship: one going in this thread, or one going on any computer for a pull request this thread has (an agent on
 * a linked computer ships it in its own thread there). Read only for a thread with pull requests (`pull_keys`, sent
 * only while Code review is on), from the same reads the Reviews list draws (data/ships.ts).
 */
import { Menu } from '@base-ui/react/menu';
import { useMemo, useState, type ReactNode } from 'react';
import { shipActive, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { InboxToastModel } from '../components/Toast';
import { Icon } from '../icons';
import { machineOf } from '../inboxUrl';
import { errorToast } from '../toastError';
import { stopShip, useShips, useShipTakers } from '../data/ships';
import { ShipLog } from './ShipLog';
import { SailGlyph } from './ShipRow';

const NO_KEYS: readonly string[] = [];

/** The active ship of this thread or of one of its pull requests, on any computer; null when none. */
export function threadShipOf(ships: Iterable<InboxShipView>, threadId: string, keys: readonly string[]): InboxShipView | null {
  const home = machineOf(threadId);
  let found: InboxShipView | null = null;
  for (const ship of ships) {
    if (!shipActive(ship)) continue;
    if (ship.thread_id === threadId && (ship.machine ?? null) === home) return ship;
    if (!found && keys.includes(ship.key)) found = ship;
  }
  return found;
}

/**
 * The thread menu's Ship items and the log they open. `anchor`: the ⋯ button (the log opens by it). Nothing at all
 * for a thread with no pull requests.
 */
export function useThreadShipMenu(thread: InboxThread, phone: boolean, anchor: HTMLElement | null, onToast?: (toast: Omit<InboxToastModel, 'id'>) => void): { items: ReactNode; log: ReactNode } {
  const keys = thread.pull_keys ?? NO_KEYS;
  const on = keys.length > 0;
  const home = machineOf(thread.thread_id);
  const takers = useShipTakers();
  const machines = useMemo(() => [...new Set([...(home ? [home] : []), ...(on ? takers : [])])].sort(), [home, on, takers]);
  const ships = useShips(on, machines, thread.thread_id);
  const ship = on ? threadShipOf(ships.values(), thread.thread_id, keys) : null;
  // The ship whose log is open: it follows that ship; once it ended it keeps showing (without Stop) until closed.
  const [shown, setShown] = useState<InboxShipView | null>(null);
  const stop = (which: InboxShipView) => {
    stopShip(which.id, which.machine ?? null).catch((cause) => onToast?.(errorToast(cause, 'Shipping didn’t stop. Try again.')));
  };
  const items = ship && (
    <>
      <Menu.Item className="ib-pmi" label="Ship log" onClick={() => setShown(ship)} data-ship-log-open="">
        <SailGlyph />
        Ship log
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Stop shipping" onClick={() => stop(ship)} data-ship-stop="">
        <Icon name="stop" size={15} />
        Stop shipping
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
  const current = shown ? ([...ships.values()].find((s) => s.id === shown.id) ?? shown) : null;
  const log = <ShipLog ship={current} anchor={anchor} phone={phone} onStop={stop} onClose={() => setShown(null)} />;
  return { items, log };
}
