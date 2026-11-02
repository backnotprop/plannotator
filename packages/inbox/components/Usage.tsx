import { useEffect, useMemo, type CSSProperties } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { InboxAccount } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { accountsFailure, useAccounts, type AccountsView, type MachineAccounts } from '../useAccounts';
import { FAILURE_TEXT, accountMeters, isHigh, isStale, rowName, shownPct, type Meter } from './Accounts';

/** Usage shows where `cswap` is: the read says so once it answers, and `installed` (the settings' look at PATH) until then. */
function hasUsage(view: AccountsView | null, installed: boolean): boolean {
  if (view === null || view.state === 'unreachable') return installed;
  return view.state === 'accounts' || view.state === 'failed';
}

const loginExpired = (account: InboxAccount) => account.usageStatus === 'relogin_required';

/** The highest limit at 90% or more, if this reading can still be trusted. */
function nearLimit(account: InboxAccount | undefined): Meter | null {
  if (!account || isStale(account) || loginExpired(account)) return null;
  const high = accountMeters(account).filter((meter) => isHigh(meter.window));
  return high.reduce<Meter | null>((top, meter) => (top && shownPct(top.window) >= shownPct(meter.window) ? top : meter), null);
}

/** Other machines stay out of the peek until the account one is using nears a limit. One that does not answer has nothing to say. */
function nearMachines(machines: MachineAccounts[]) {
  return machines.flatMap(({ id, name, read }) => {
    const meter = read?.state === 'accounts' ? nearLimit(read.accounts.find((account) => account.active)) : null;
    return meter ? [{ id, name, meter }] : [];
  });
}

/** The sidebar's row: plain, until the account in use nears a limit. No `cswap`, no row. */
export function UsageRow({ installed, open, onOpen }: { installed: boolean; open: boolean; onOpen: (row: HTMLElement) => void }) {
  const { view } = useAccounts();
  if (!hasUsage(view, installed)) return null;
  const near = view?.state === 'accounts' ? nearLimit(view.accounts.find((account) => account.active)) : null;
  const figure = near && shownPct(near.window);
  return (
    <button
      type="button"
      className="ib-nav"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={figure === null ? 'Usage' : `Usage: ${figure} percent used`}
      data-usage-nav=""
      data-open={open ? '' : undefined}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <Icon name="user" />
      Usage
      {figure !== null && (
        <span className="ib-usage-fig" data-usage-figure="">
          <HostMark host="claude-code" />
          {figure}%
        </span>
      )}
    </button>
  );
}

function UsageLine({ meter, muted }: { meter: Meter; muted: boolean }) {
  const high = isHigh(meter.window) && !muted;
  const shown = shownPct(meter.window);
  return (
    <>
      <span className="ib-usage-k">{meter.label}</span>
      <i className="ib-usage-tr" data-high={high ? '' : undefined} aria-hidden="true" style={{ '--ib-acct-w': `${Math.min(Math.max(shown, 0), 100)}%` } as CSSProperties} />
      <span className="ib-usage-v" data-high={high ? '' : undefined}>
        {shown}%
      </span>
      <span className="ib-usage-t">{high ? meter.window.clock : null}</span>
    </>
  );
}

/** What the block says beside the name, when it has no limits to draw or they cannot be trusted. */
function sideNote(account: InboxAccount, meters: Meter[]): string | null {
  if (loginExpired(account)) return 'Login expired';
  if (account.usageStatus === 'api_key') return 'API key';
  return meters.length === 0 ? 'No reading yet' : null;
}

/** The peek's one block. All of it opens Settings → Accounts: that is where anything gets done. */
function UsageBlock({ name, note, meters, muted, onOpen }: { name: string; note?: string | null; meters?: Meter[]; muted?: boolean; onOpen: () => void }) {
  const lines = meters ?? [];
  return (
    <button type="button" className="ib-usage-row" aria-label={`${name}. Open Accounts in Settings.`} data-usage-block="" onClick={onOpen}>
      <span className="ib-usage-who">
        <HostMark host="claude-code" />
        <span className="ib-usage-nm">{name}</span>
        {note && <span className="ib-usage-note">{note}</span>}
        <Icon name="chevR" size={12} className="ib-usage-go" />
      </span>
      {lines.length > 0 && (
        <span className="ib-usage-lines" data-muted={muted ? '' : undefined} data-reset={!muted && lines.some((meter) => isHigh(meter.window)) ? '' : undefined}>
          {lines.map((meter) => (
            <UsageLine key={meter.label} meter={meter} muted={muted ?? false} />
          ))}
        </span>
      )}
    </button>
  );
}

/** Another machine at 90% or more: its name and that limit. It opens the same place. */
function NearMachine({ name, meter, onOpen }: { name: string; meter: Meter; onOpen: () => void }) {
  const figure = `${meter.label} ${shownPct(meter.window)}`;
  return (
    <button type="button" className="ib-usage-row" aria-label={`${name}, ${figure} percent. Open Accounts in Settings.`} data-usage-machine="" onClick={onOpen}>
      <span className="ib-usage-who">
        <HostMark host="claude-code" />
        <span className="ib-usage-nm">{name}</span>
        <span className="ib-usage-note" data-high="">
          {figure}%
        </span>
        <Icon name="chevR" size={12} className="ib-usage-go" />
      </span>
    </button>
  );
}

function ThisMachine({ onOpen }: { onOpen: () => void }) {
  const { view } = useAccounts();
  const failure = view && accountsFailure(view);
  if (failure) return <UsageBlock name={FAILURE_TEXT[failure]} onOpen={onOpen} />;
  if (view?.state !== 'accounts') return <UsageBlock name="Reading accounts…" onOpen={onOpen} />;
  if (view.accounts.length === 0) return <UsageBlock name="No accounts yet" onOpen={onOpen} />;
  const active = view.accounts.find((account) => account.active);
  if (!active) return <UsageBlock name="No account in use" onOpen={onOpen} />;
  const { label, number } = rowName(view.accounts, active);
  const meters = accountMeters(active);
  return (
    <UsageBlock
      name={number === null ? label : `${label} #${number}`}
      note={sideNote(active, meters)}
      meters={meters}
      muted={isStale(active) || loginExpired(active)}
      onOpen={onOpen}
    />
  );
}

/**
 * The Usage row's peek (approval "accounts-page"): read-only, the account in
 * use and its limits, then any other machine at 90% or more. On a phone the
 * same content is the Inbox's bottom sheet. `anchor` is the row; null is closed.
 */
export function UsagePeek({ anchor, phone, onClose, onSettings }: { anchor: HTMLElement | null; phone: boolean; onClose: () => void; onSettings: () => void }) {
  const { view, machines } = useAccounts();
  const near = nearMachines(machines);
  const row = useMemo(() => ({ current: anchor }), [anchor]);
  // Where the row was as it opened: the peek stays put when the row goes (the hover sidebar slides away).
  const placedAt = useMemo(() => anchor?.getBoundingClientRect() ?? null, [anchor]);
  const grown = `${view === null} ${near.length}`;
  // A new reference places it again at its new size, and an answer that grows it changes nothing else: its focus stays.
  const place = useMemo(() => (placedAt ? { getBoundingClientRect: () => placedAt } : undefined), [placedAt, grown]);
  const open = anchor !== null && hasUsage(view, true);
  // The read took `cswap` away while it was open, and the row with it.
  useEffect(() => {
    if (anchor !== null && !open) onClose();
  }, [anchor, open, onClose]);
  return (
    <Popover.Root
      key={phone ? 'sheet' : 'peek'}
      open={open}
      modal={phone}
      onOpenChange={(next, details) => {
        // The row closes it itself: left to this, the press would close it and the click open it again.
        const rowPress = details.reason === 'outside-press' && details.event.target instanceof Node && anchor?.contains(details.event.target);
        if (!next && !rowPress) onClose();
      }}
    >
      <Popover.Portal container={document.querySelector<HTMLElement>('.pn-inbox') ?? undefined}>
        {phone && <Popover.Backdrop className="ib-pm-scrim" />}
        {/* Stays put when the row goes: the hover sidebar slides away, and a phone's closes. */}
        <Popover.Positioner className="ib-tidy-pos" anchor={place} side="right" align="end" sideOffset={14} disableAnchorTracking data-phone={phone ? '' : undefined}>
          <Popover.Popup
            className="ib-tidy ib-usage"
            aria-label="Usage"
            finalFocus={phone ? false : row}
            data-usage-peek=""
            onKeyDown={(event) => {
              // Tab past either end closes it, back on the row: left alone, focus lands on a guard behind the open peek.
              if (phone || event.key !== 'Tab') return;
              const popup = event.currentTarget;
              const blocks = popup.querySelectorAll('button');
              // The popup itself holds focus after a click on its padding: it is the first stop going back.
              const leaving = event.shiftKey ? event.target === popup || event.target === blocks[0] : event.target === blocks[blocks.length - 1];
              if (!leaving) return;
              event.preventDefault();
              onClose();
            }}
          >
            <ThisMachine onOpen={onSettings} />
            {near.map(({ id, name, meter }) => (
              <NearMachine key={id} name={name} meter={meter} onOpen={onSettings} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
