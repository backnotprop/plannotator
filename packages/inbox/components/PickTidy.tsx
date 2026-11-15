/**
 * Tidy… on the picked threads (approval "inbox-multi-select", 4b): Tidy's own popover, scoped to the picks. Each
 * machine that holds picked threads is read and asked about its own (tidyAcross.ts); a thread nobody can be asked
 * about is counted in one line. On a phone it is the sheet Tidy's popover is there.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import type { MachinesModel } from '../machines';
import { pickTargets, readAcross, startAcross, type TidyAcrossPlan } from '../tidyAcross';
import type { TidyController } from './Tidy';
import { TidyPanel } from './TidyPanel';

/** A Tidy controller for the picked rows: read when it opens, and again after a start. */
function usePickTidy(rows: readonly InboxListRow[], machines: MachinesModel | undefined, open: boolean): TidyController {
  const [plan, setPlan] = useState<TidyAcrossPlan | null>(null);
  const seq = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const targets = () => pickTargets(rowsRef.current, machines ?? { self: null, all: [], linked: [], names: new Map(), away: new Set() });
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    readAcross(targets(), (target) => inboxApi.tidy(null, 'list', target.machine, target.threads))
      .then((next) => mine === seq.current && setPlan(next))
      .catch(() => mine === seq.current && setPlan(null));
    // `targets` reads the rows of the moment it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines]);
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    refresh();
  }, [open, refresh]);
  const start = useCallback<TidyController['start']>(
    async (agents, key, words) => {
      const threadsOf = new Map(targets().map((t) => [t.machine, t.threads ?? []]));
      const failed = await startAcross(agents, key, (machine, sessions, partKey) =>
        inboxApi.startTidy({ sessions, idempotency_key: partKey, project: null, surface: 'list', thread_ids: threadsOf.get(machine) ?? [], ...(words ? { words } : {}) }, machine),
      );
      refresh();
      return failed;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh],
  );
  return { surface: 'list', scope: null, plan, run: plan?.run ?? null, start, refresh, picked: rows.length };
}

/** The popover, at `anchor` (the bar's Tidy…, else its ⋯); closed while `anchor` is null. */
export function PickTidy({ rows, machines, anchor, phone, onClose }: { rows: readonly InboxListRow[]; machines?: MachinesModel; anchor: HTMLElement | null; phone: boolean; onClose: () => void }) {
  const open = anchor !== null;
  const tidy = usePickTidy(rows, machines, open);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor?.closest<HTMLElement>('.pn-inbox') ?? document.querySelector<HTMLElement>('.pn-inbox')), [anchor]);
  return (
    <Popover.Root open={open} onOpenChange={(next) => !next && onClose()} modal={phone}>
      <Popover.Portal container={portal ?? undefined}>
        {phone && <Popover.Backdrop className="ib-pm-scrim" />}
        <Popover.Positioner className="ib-tidy-pos" anchor={anchor} side="bottom" align="start" sideOffset={6} data-phone={phone ? '' : undefined}>
          <Popover.Popup className="ib-tidy" aria-label="Tidy the selected threads" finalFocus={() => (anchor?.isConnected ? anchor : true)} data-tidy-popover="" data-pick-tidy-popover="">
            {open && <TidyPanel tidy={tidy} onDone={onClose} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
