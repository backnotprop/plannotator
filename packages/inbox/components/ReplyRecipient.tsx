/**
 * Who gets the reply (approval "inbox-reply-recipient", option E "Under the
 * box, right"): in a thread with more than one agent, a pill in the box's own
 * row, at the right of what goes with the reply, "to [tile] Claude Code
 * (plannotator) ⌄" (approval "inbox-reply-box", T6). A computer only: a phone's
 * is PhoneReplyRecipient.tsx, in the row with a bottom sheet.
 *
 * Tap it for the thread's agents (live first, ended last), the chosen ones
 * ticked. Tap a name: only that agent. Tap a circle: that agent too ("2
 * agents", the names on hover). An ended agent, or one on an older
 * Plannotator, can't be a second recipient. The last row, "Tag another
 * agent", types a real `@`. The list is the `@` list's box and tiles, not its
 * code (that one follows the caret and only adds). When the session asked has
 * ended, a start row closes the list: New message's "+ [mark] New Claude Code
 * session in ledger" (thread/replyStart.ts); it takes the reply alone.
 *
 * The rules are replyRecipients.ts; ThreadPane owns the choice and Send. The
 * rows are named as a phone's sheet names them (thread/recipientNames.ts).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { graphemesOf } from '@plannotator/core/inbox-format';
import { HostMark, Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import type { SessionLabels } from '../sessionLabels';
import { namesList } from '../tags';
import { recipientNames, useRecipientLabels } from '../thread/recipientNames';
import { TagStack } from './TagPicker';
import { Tip } from './Tip';
import { markRecipientList } from '../pageMarks';

/** The longest title the pill shows; a longer one leaves the pill its fallback name, and the title goes to its hover. */
const PILL_TITLE_MAX = 26;
const NO_LABELS: SessionLabels = {};
const NO_FOLDER = () => '';

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

/** A start row's lead: New message's "+" and the agent's mark. */
const StartTile = ({ host }: { host: string | null }) => (
  <>
    <span className="ib-cp-plus" aria-hidden="true">
      <Icon name="plus" size={12} />
    </span>
    <span className="ib-atile">
      <HostMark host={host} />
    </span>
  </>
);

export function ReplyRecipient({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  labels = NO_LABELS,
  folderOf = NO_FOLDER,
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
  /** Each session's title, where it has one: the pill and the list show it over the fallback name. */
  labels?: SessionLabels;
  /** The folder a session works in, as the thread knows it. */
  folderOf?: (session: string) => string;
}) {
  const listId = useRef(`ib-rpick-${Math.random().toString(36).slice(2)}`).current;
  const chosenIds = chosen.map((r) => r.session);
  const one = chosen.length === 1 ? chosen[0]! : null;
  const named = recipientNames(rows, useRecipientLabels(labels), folderOf);
  const nameOf = (row: RecipientRow) => named.get(row.session)?.name ?? row.label;
  /** The pill's wide name: the row's name while it is short enough to fit, else the fallback name. */
  const pillOf = (row: RecipientRow) => {
    const name = nameOf(row);
    return graphemesOf(name).length <= PILL_TITLE_MAX ? name : row.label;
  };
  const names = namesList(chosen.map(nameOf));
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

  const tile = one?.start ? (
    <StartTile host={one.host} />
  ) : one ? (
    <span className="ib-atile">
      <HostMark host={one.host} agent={one.session} />
    </span>
  ) : (
    <TagStack participants={chosen} />
  );
  const words = one ? pillOf(one) : `${chosen.length} agents`;
  const button = (
    <button
      type="button"
      className="ib-rto"
      data-recipient=""
      data-ended={ended ? '' : undefined}
      aria-label={`To ${names}${ended ? ', ended' : ''}. Change who gets this reply`}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      // The press must not take focus from the reply field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(!open)}
    >
      <Face tile={tile} full={words} short={one ? one.short : words} ended={ended} />
    </button>
  );

  const list = open ? (
    <div ref={markRecipientList} className="ib-tg-menu ib-rpick" id={listId} data-recipient-list="" role="group" aria-label="Who gets this reply" onMouseDown={(event) => event.preventDefault()}>
      {rows.map((row) => {
        const on = chosenIds.includes(row.session);
        const { title, agent } = named.get(row.session)!;
        const quiet = QUIET[row.state];
        if (row.start) {
          // Picked like a name; its circle only shows the choice (a new session is never a second recipient).
          return (
            <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-recipient-start={row.host ?? ''} data-on={on ? '' : undefined}>
              <button type="button" className="ib-rpick-name" aria-label={`${row.label} in ${row.start.project}`} onClick={() => onOnly(row)}>
                <StartTile host={row.host} />
                <span className="ib-rpick-l" dir="auto">
                  {row.label}
                </span>
                <span className="ib-cp-stin" dir="auto">
                  in {row.start.project}
                </span>
                {row.start.asleep && <span className="ib-rpick-q">starts when it's back</span>}
              </button>
              <button type="button" role="checkbox" aria-checked={on} aria-hidden="true" tabIndex={-1} className="ib-rpick-tick" onClick={() => onOnly(row)}>
                <span>
                  <Icon name="check" size={12} />
                </span>
              </button>
            </div>
          );
        }
        return (
          <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-on={on ? '' : undefined}>
            <button type="button" className="ib-rpick-name" disabled={row.alone === false} onClick={() => onOnly(row)}>
              <span className="ib-atile">
                <HostMark host={row.host} agent={row.session} />
              </span>
              <span className="ib-rpick-ol">
                <span className="ib-rpick-l" dir="auto" title={title ? nameOf(row) : undefined}>
                  {nameOf(row)}
                </span>
                <span className="ib-rpick-d" dir="auto">
                  {agent && `${agent} · `}
                  {quiet ? <span className="ib-rpick-q">{quiet}</span> : folderOf(row.session)}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Also send to ${nameOf(row)}`}
              className="ib-rpick-tick"
              data-recipient-tick={row.session}
              disabled={!canAddRecipient(row, chosenIds, rows)}
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
      {!open && (chosen.length > 1 || (one && words !== nameOf(one))) ? <Tip content={names}>{button}</Tip> : button}
      {list}
    </span>
  );
  // A wide window: every name stacked under the pill, so the Draft words beside it never move when it changes.
  return (
    <span className="ib-rto-slot">
      {rows.map((row) => (
        <span key={row.session} className="ib-rto ib-rto-ghost" aria-hidden="true">
          <Face tile={<span className="ib-atile" />} full={pillOf(row)} short={row.short} ended={row.state === 'ended'} />
        </span>
      ))}
      {pill}
    </span>
  );
}
