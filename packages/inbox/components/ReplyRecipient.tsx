/**
 * Who gets the reply (approval "inbox-reply-recipient", option E "Under the
 * box, right"): in a thread with more than one agent, a pill at the right end
 * of Send's row, "to [tile] Claude Code (plannotator) ⌄". On a phone it sits
 * after Cancel and shows the folder alone.
 *
 * Tap it for the thread's agents (live first, ended last), the chosen ones
 * ticked. Tap a name: only that agent. Tap a circle: that agent too ("2
 * agents", the names on hover). An ended agent, or one on an older
 * Plannotator, can't be a second recipient. The last row, "Tag another
 * agent", types a real `@`. The list is the `@` list's box and tiles, not its
 * code (that one follows the caret and only adds).
 *
 * The rules are replyRecipients.ts; ThreadPane owns the choice and Send.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HostMark, Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import { namesList } from '../tags';
import { TagStack } from './TagPicker';
import { Tip } from './Tip';

function Face({ tile, full, short, ended }: { tile: ReactNode; full: string; short: string; ended: boolean }) {
  return (
    <>
      <span className="ib-rto-l">to</span>
      {tile}
      <span className="ib-rto-n">
        <span className="ib-rto-full" dir="auto">
          {full}
        </span>
        <span className="ib-rto-short" dir="auto">
          {short}
        </span>
      </span>
      {ended && <span className="ib-rto-q">ended</span>}
      <svg className="ib-rto-c" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  );
}

const QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };

export function ReplyRecipient({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  phone,
  section,
}: {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (a typed `@` included). */
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  onToggle: (row: RecipientRow) => void;
  onTagAnother: () => void;
  phone: boolean;
  /** The thread's pane: on a phone the list is drawn in it, over the foot and above the keyboard. */
  section: HTMLElement | null;
}) {
  const listId = useRef(`ib-rpick-${Math.random().toString(36).slice(2)}`).current;
  const chosenIds = chosen.map((r) => r.session);
  const one = chosen.length === 1 ? chosen[0]! : null;
  const names = namesList(chosen.map((r) => r.label));
  const ended = one?.state === 'ended';

  // A press outside the pill and its list closes the list; so does Escape, before anything else hears it.
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('[data-recipient-list], [data-recipient]')) onOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(false);
    };
    document.addEventListener('pointerdown', press);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onOpen]);

  // On a phone the keyboard leaves little room and the foot clips what is inside it: the list sits over the box,
  // from just above Send's row (the pill stays in sight, a tap on it closes the list) up to the header, never behind it.
  const [spot, setSpot] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open || !phone || !section) {
      setSpot(undefined);
      return;
    }
    const row = section.querySelector('[data-reply-row] .ib-footbtns')?.getBoundingClientRect();
    const head = section.querySelector('.ib-phead')?.getBoundingClientRect();
    if (!row || !head) return;
    const top = Math.round(row.top - 6);
    setSpot({ position: 'fixed', left: 12, right: 12, bottom: 'auto', top, width: 'auto', maxWidth: 'none', margin: 0, transform: 'translateY(-100%)', maxHeight: Math.max(120, top - head.bottom - 8) });
  }, [open, phone, section]);

  const tile = one ? (
    <span className="ib-atile">
      <HostMark host={one.host} />
    </span>
  ) : (
    <TagStack participants={chosen} />
  );
  const words = one ? one.label : `${chosen.length} agents`;
  const button = (
    <button
      type="button"
      className="ib-rto"
      data-recipient=""
      data-ended={ended ? '' : undefined}
      aria-label={`To ${names}${ended ? ', ended' : ''}. Change who gets this reply`}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      // The press must not take focus from the reply field: on a phone the keyboard stays up.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(!open)}
    >
      <Face tile={tile} full={words} short={one ? one.short : words} ended={ended} />
    </button>
  );

  const list = open ? (
    <div className="ib-tg-menu ib-rpick" id={listId} data-recipient-list="" role="group" aria-label="Who gets this reply" style={spot} onMouseDown={(event) => event.preventDefault()}>
      {rows.map((row) => {
        const on = chosenIds.includes(row.session);
        const quiet = QUIET[row.state];
        return (
          <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-on={on ? '' : undefined}>
            <button type="button" className="ib-rpick-name" onClick={() => onOnly(row)}>
              <span className="ib-atile">
                <HostMark host={row.host} />
              </span>
              <span className="ib-rpick-l" dir="auto">
                {row.label}
              </span>
              {quiet && <span className="ib-rpick-q">{quiet}</span>}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Also send to ${row.label}`}
              className="ib-rpick-tick"
              data-recipient-tick={row.session}
              disabled={!canAddRecipient(row, chosenIds)}
              onClick={() => onToggle(row)}
            >
              <span>
                <Icon name="check" size={12} />
              </span>
            </button>
          </div>
        );
      })}
      <button type="button" className="ib-rpick-more" data-recipient-tag="" onClick={onTagAnother}>
        Tag another agent
      </button>
    </div>
  ) : null;

  const pill = (
    <span className="ib-rto-wrap">
      {chosen.length > 1 && !open ? <Tip content={names}>{button}</Tip> : button}
      {phone && list && section ? createPortal(list, section) : list}
    </span>
  );
  if (phone) return pill;
  // A wide window: every name stacked under the pill, so the Draft words beside it never move when it changes.
  return (
    <span className="ib-rto-slot">
      {rows.map((row) => (
        <span key={row.session} className="ib-rto ib-rto-ghost" aria-hidden="true">
          <Face tile={<span className="ib-atile" />} full={row.label} short={row.short} ended={row.state === 'ended'} />
        </span>
      ))}
      {pill}
    </span>
  );
}
