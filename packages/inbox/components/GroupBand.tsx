import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { Tip } from './Tip';

/**
 * A group's header: the whole header is the toggle (approval "inbox-list-groups-close"). Its chevron shows at once
 * while the pointer is on the header, as the sidebar's sections do (owner, 2026-11-08: no wait), or while keyboard
 * focus is on it. A touch never shows it, as before. `data-chev` shows it; inbox.css fades it in and out. Its own
 * state, so only this header redraws.
 */
export function GroupBand({ open, onToggle, children }: { open: boolean; onToggle: (band: HTMLButtonElement) => void; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [focusShown, setFocusShown] = useState(false);
  return (
    <button
      type="button"
      className="ib-band"
      aria-expanded={open}
      data-chev={hovered || focusShown ? '' : undefined}
      onClick={(event) => onToggle(event.currentTarget)}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
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
      <Icon name="chevR" className="ib-band-chev" />
    </button>
  );
}

/**
 * A button over a group header's right end, beside its chevron (the "New since you looked" band's Mark all as read,
 * markAllRead.ts): the header is the group's toggle, so this is its sibling, after it. Icon only, its name the
 * tooltip. It takes no height of its own (inbox.css `.ib-band-act`), so the header and its count never move. On a
 * wider window it shows with the chevron (the pointer on the header, or keyboard focus on either); a phone always shows it.
 */
export function BandAction({ label, icon, onClick, ...data }: { label: string; icon: IconName; onClick: () => void } & Record<`data-${string}`, string>) {
  return (
    <Tip content={label}>
      <button type="button" className="ib-band-act" aria-label={label} onClick={onClick} {...data}>
        <Icon name={icon} size={15} />
      </button>
    </Tip>
  );
}
