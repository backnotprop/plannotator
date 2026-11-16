/**
 * The tag colour menu's two-dimensional square (approval "inbox-tag-colors-picker"): a traditional saturation and
 * brightness square at the current hue, left to right muted to vivid, top to bottom light to dark. One focus stop, a
 * slider named "Color" whose value says both ("Saturation 72%, brightness 58%"). Its own arrow keys move it by 1%
 * (Left and Right saturation, Up and Down brightness; PageUp and PageDown brightness by 10%, Home and End saturation
 * to its ends) and stop at its edges: they never leave it (Tab and Shift+Tab do), so passing it changes nothing. A drag
 * (mouse, pen or finger: `touch-action: none`) moves it live; letting go ends it. Every other key stays its own, so
 * the menu's typeahead and arrows do not take them; Escape goes on to the menu.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { hsvToHex } from '../tagColourMap';

export interface SquareProps {
  /** The hue the square is drawn at (0–360). */
  hue: number;
  /** Saturation and brightness, whole percents. */
  s: number;
  v: number;
  /** A move: by a key (kept once it rests) or a drag (shown while it moves). */
  onMove: (s: number, v: number, by: 'key' | 'pointer') => void;
  /** A drag let go. */
  onLetGo: (s: number, v: number) => void;
  onBlur?: () => void;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function ColorSquare({ hue, s, v, onMove, onLetGo, onBlur }: SquareProps) {
  const dragging = useRef(false);
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    const y = box.height > 0 ? (event.clientY - box.top) / box.height : 0;
    return { s: clamp(x * 100), v: clamp(100 - y * 100) };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
    const step = (ds: number, dv: number) => {
      event.preventDefault();
      const next = { s: clamp(s + ds), v: clamp(v + dv) };
      if (next.s !== s || next.v !== v) onMove(next.s, next.v, 'key');
    };
    switch (event.key) {
      case 'ArrowLeft':
        return step(-1, 0);
      case 'ArrowRight':
        return step(1, 0);
      case 'ArrowUp':
        return step(0, 1);
      case 'ArrowDown':
        return step(0, -1);
      case 'PageUp':
        return step(0, 10);
      case 'PageDown':
        return step(0, -10);
      case 'Home':
        return step(-100, 0);
      case 'End':
        return step(100, 0);
    }
  };
  return (
    <div className="ib-tagc-sqw">
      <div
        className="ib-tagc-sq"
        role="slider"
        tabIndex={0}
        aria-label="Color"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={s}
        aria-valuetext={`Saturation ${s}%, brightness ${v}%`}
        data-tag-colour-square=""
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(hue)} 100% 50%))` }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.currentTarget.focus({ preventScroll: true });
          const next = at(event);
          onMove(next.s, next.v, 'pointer');
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          const next = at(event);
          if (next.s !== s || next.v !== v) onMove(next.s, next.v, 'pointer');
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          const next = at(event);
          onLetGo(next.s, next.v);
        }}
        onPointerCancel={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onLetGo(s, v);
        }}
      >
        <span className="ib-tagc-sqt" aria-hidden="true" style={{ left: `${s}%`, top: `${100 - v}%`, background: hsvToHex(hue, s / 100, v / 100) }} />
      </div>
    </div>
  );
}
