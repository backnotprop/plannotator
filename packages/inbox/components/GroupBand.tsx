import { useRef, useState, type ReactNode } from 'react';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Tip } from './Tip';

/**
 * A group's header: the whole header is the toggle (approval "inbox-list-groups-close"). Its chevron shows at once
 * while the pointer is on the header, as the sidebar's sections do (owner, 2026-11-08: no wait), or while keyboard
 * focus is on it. A touch never shows it, as before. `data-chev` shows it; inbox.css fades it in and out. Its own
 * state, so only this header redraws. `menu`: its right-click menu is open (RowMenu.tsx `bands`), the hover's fill;
 * `keys`: that menu's keys, while the band has one (no `aria-haspopup`: Enter toggles the band, it opens no menu).
 * `tip`: the Group tip's words (bandTip.ts), shown while set; `onPointed` and `onLeft`: the pointer came onto the band
 * (a mouse, never a touch) and left it, for the tip. The tip keeps its last words while it fades out, so no empty
 * bubble is drawn. The tip sits on the band itself and covers no row: it hangs on an empty anchor of no size (`.ib-band-tipat`), just after the name and count on a
 * desktop (`tipEnd` false: it reads to their right), at the band's right end on a phone (`tipEnd`: it reads to the
 * anchor's left, inside the band). The anchor is always inside its Tip (empty, it never opens), so showing the tip
 * never draws the band again, and it neither changes the band's height nor moves its name or chevron. The pointer goes
 * through the tip (inbox.css `[data-band-tip]`): a right-click on it opens the band's menu, a click toggles the band.
 */
export function GroupBand({
  open,
  onToggle,
  menu = false,
  keys,
  tip = null,
  tipEnd = false,
  onPointed,
  onLeft,
  children,
}: {
  open: boolean;
  onToggle: (band: HTMLButtonElement) => void;
  menu?: boolean;
  keys?: string;
  tip?: string | null;
  tipEnd?: boolean;
  onPointed?: () => void;
  onLeft?: () => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focusShown, setFocusShown] = useState(false);
  // The tip's last words, kept while it fades out (an empty content would draw an empty bubble leaving).
  const words = useRef<string | null>(null);
  if (tip) words.current = tip;
  return (
    <button
      type="button"
      className="ib-band"
      aria-expanded={open}
      data-chev={hovered || focusShown ? '' : undefined}
      data-menu={menu ? '' : undefined}
      aria-keyshortcuts={keys}
      onClick={(event) => onToggle(event.currentTarget)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        setHovered(true);
        onPointed?.();
      }}
      onPointerLeave={() => {
        setHovered(false);
        onLeft?.();
      }}
      onFocus={(event) => {
        // Keyboard focus only: a click's focus (or a tap's) shows nothing by itself.
        let keyboard = true;
        try {
          keyboard = event.currentTarget.matches(':focus-visible');
        } catch {
          // No :focus-visible in this engine: count it as keyboard focus.
        }
        if (keyboard) setFocusShown(true);
      }}
      onBlur={() => setFocusShown(false)}
    >
      {children}
      <Tip content={words.current ? <span data-band-tip="">{words.current}</span> : ''} open={tip ? true : false} when={NEVER} side={tipEnd ? 'left' : 'right'} align="center">
        <span className="ib-band-tipat" data-end={tipEnd ? '' : undefined} />
      </Tip>
      <Icon name="chevR" className="ib-band-chev" />
    </button>
  );
}

/** The tip never opens by a hover of its anchor: only while `tip` is set. */
const NEVER = () => false;

/**
 * A closed group with an agent stopped or held up inside (Stopped on you, Holding up work, the Snoozed band): the
 * triangle, so a blocker never hides behind the fold.
 */
export function FoldedBlocker({ rows, group }: { rows: readonly InboxListRow[]; group: InboxListGroupId }) {
  const stopped = rows.some((row) => row.section === 'stopped');
  if (!stopped && !rows.some((row) => row.section === 'holding')) return null;
  const snoozed = group === 'snoozed';
  const words = snoozed
    ? stopped
      ? 'A snoozed thread is stopped on you'
      : 'A snoozed thread is holding up work'
    : stopped
      ? 'A closed thread is stopped on you'
      : 'A closed thread is holding up work';
  return (
    <span className="ib-zband-tri" data-stopped={stopped ? '' : undefined} data-snooze-blocker={snoozed ? '' : undefined} data-folded-blocker="" role="img" aria-label={words}>
      <Icon name="warn" size={14} />
    </span>
  );
}

/** Something new came into a closed group since it was closed: an unread row whose latest agent message came after. */
export function newSince(rows: readonly InboxListRow[], since: number): boolean {
  return rows.some((row) => row.unread && Date.parse(row.last_agent_at ?? row.last_at) > since);
}
