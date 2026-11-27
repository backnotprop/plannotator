/**
 * The ship log (approval "inbox-ship-mode"): what the agent did and what the Inbox saw, newest first, with Stop. From a
 * shipping row's menu (a popover by the row; a phone's sheet) and on the review's page. Read from the computer that
 * holds the ship (data/ships.ts), again whenever its ships change.
 */
import { useEffect, useMemo, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { shipActive, shipTimeWords, type InboxShipLogEntry, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { HostMark, Icon } from '../icons';
import { BottomSheet } from '../components/BottomSheet';
import { readShipLog, shipEvents } from '../data/ships';
import { linkedMachineFacts, linkedMachinesWith, selfMachineName } from '../inboxUrl';
import { SailGlyph } from './ShipRow';

function useShipLog(ship: InboxShipView | null): InboxShipLogEntry[] | null {
  const [log, setLog] = useState<{ id: string; entries: InboxShipLogEntry[] } | null>(null);
  const id = ship?.id ?? null;
  const machine = ship?.machine ?? null;
  useEffect(() => {
    if (!id) return;
    let gone = false;
    const read = () =>
      readShipLog(id, machine).then(
        (got) => {
          if (!gone) setLog({ id, entries: got.log });
        },
        () => {},
      );
    void read();
    const off = shipEvents.subscribe(() => void read());
    return () => {
      gone = true;
      off();
    };
  }, [id, machine, ship?.state, ship?.reason]);
  return log && log.id === id ? log.entries : null;
}

/** The computer the agent ships on, by its name, once another computer that ships is linked (alone, there is one). */
export function shipComputer(ship: Pick<InboxShipView, 'machine'>): string | null {
  if (ship.machine) return linkedMachineFacts(ship.machine)?.name ?? null;
  return linkedMachinesWith('ships').length > 0 ? selfMachineName() : null;
}

/** The log's body: its head with Stop, who ships it, the entries. */
export function ShipLogBody({ ship, onStop, now = Date.now() }: { ship: InboxShipView; onStop: () => void; now?: number }) {
  const log = useShipLog(ship);
  const today = useMemo(() => new Date(now), [now]);
  return (
    <div className="ib-shp-log" data-ship-log={ship.id}>
      <div className="ib-shp-log-h">
        <SailGlyph />
        <b>Ship log</b>
        {shipActive(ship) && (
          <button type="button" className="ib-shp-stop" onClick={onStop} data-ship-log-stop="">
            <Icon name="stop" size={13} />
            Stop
          </button>
        )}
      </div>
      <div className="ib-shp-who">
        {ship.agent.host && <HostMark host={ship.agent.host} agent={ship.agent.session} />}
        {[ship.agent.name, ship.repo.split('/').pop(), shipComputer(ship)].filter(Boolean).join(' · ')}
      </div>
      <div className="ib-shp-list" role="list" aria-busy={log === null ? true : undefined}>
        {(log ?? []).map((entry, i) => (
          <div key={`${entry.at}:${i}`} className="ib-shp-e" role="listitem" data-kind={entry.kind} data-by={entry.by} data-now={i === 0 ? '' : undefined}>
            <span className="ib-shp-tm">{shipTimeWords(entry.at, today)}</span>
            <span dir="auto">
              {entry.text}
              {entry.sha && (
                <>
                  {' '}
                  <code>{entry.sha}</code>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The log by its row (`anchor`), or a phone's sheet. Null `ship`: closed. */
export function ShipLog({ ship, anchor, phone, onStop, onClose }: { ship: InboxShipView | null; anchor: HTMLElement | null; phone: boolean; onStop: (ship: InboxShipView) => void; onClose: () => void }) {
  const host = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.pn-inbox');
  const placedAt = useMemo(() => anchor?.getBoundingClientRect() ?? null, [anchor]);
  const place = useMemo(() => (placedAt ? { getBoundingClientRect: () => placedAt } : undefined), [placedAt]);
  if (phone) {
    return (
      <BottomSheet open={ship !== null} onClose={onClose} title="Ship log" host={host} attrs={{ 'data-ship-log-sheet': '' }}>
        <div className="ib-shp-sheet">{ship && <ShipLogBody ship={ship} onStop={() => onStop(ship)} />}</div>
      </BottomSheet>
    );
  }
  return (
    <Popover.Root
      open={ship !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Popover.Portal container={host ?? undefined}>
        <Popover.Positioner className="ib-tidy-pos" anchor={place} side="bottom" align="end" sideOffset={4} disableAnchorTracking>
          <Popover.Popup className="ib-shp-pop" aria-label="Ship log" finalFocus={anchor ? { current: anchor } : true}>
            {ship && <ShipLogBody ship={ship} onStop={() => onStop(ship)} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
