import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';

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
