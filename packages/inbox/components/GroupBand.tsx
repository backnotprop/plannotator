import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Tip } from './Tip';

/**
 * A group's header: the whole header is the toggle (approval "inbox-list-groups-close"). Its chevron shows at once
 * while the pointer is on the header, as the sidebar's sections do (owner, 2026-11-08: no wait), or while keyboard
 * focus is on it. A touch never shows it, as before. `data-chev` shows it; inbox.css fades it in and out. Its own
 * state, so only this header redraws. `menu`: its right-click menu is open (RowMenu.tsx `bands`), the hover's fill;
 * `keys`: that menu's keys, while the band has one. `tip`: the Group tip's words (bandTip.ts), shown as the band's
 * tooltip while set; `onPointed`: the pointer came onto the band (a mouse, never a touch), for the tip. The band is
 * always inside its Tip (empty, it never opens), so showing the tip never draws the band again.
 */
export function GroupBand({
  open,
  onToggle,
  menu = false,
  keys,
  tip = null,
  onPointed,
  children,
}: {
  open: boolean;
  onToggle: (band: HTMLButtonElement) => void;
  menu?: boolean;
  keys?: string;
  tip?: string | null;
  onPointed?: () => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focusShown, setFocusShown] = useState(false);
  return (
    <Tip content={tip ?? ''} open={tip ? true : undefined} side="bottom" align="start">
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
    </Tip>
  );
}
