/**
 * What was asked or changed on a part of the board, and what came back, in that part's comment box (above the
 * words). The board's side panel is References only (the owner, 2026-11-16: "Honestly, it's just the reference
 * panel"), so a part's Ask answers here: on the part it was asked about, streaming as it comes; the board's Global
 * comment box lists every question and change on the board. Read-only: the box under it asks again.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeNoteBox } from '@plannotator/core/shape';
import { useVisibleViewportBounds } from '../../hooks/useViewportEnvironment';
import { renderChatMarkdown } from '../../utils/aiChatFormat';
import { boundsWithin, computeCommentPopoverPosition, sheetWithin } from '../CommentPopover';
import { Pebble } from './Pebble';

export interface ShapeTalkEntry {
  id: string;
  /** Where on the board ("Shape · “Save”", "The whole board"). */
  label: string;
  /** The person's words. */
  words: string;
  change: boolean;
  /** The answer so far (markdown); empty while it waits. */
  answer: string;
  streaming: boolean;
  /** A change's state ("Sent to Claude Code", "Waits for the agent"). */
  status?: string;
  error?: string;
  /** The part it is on (its view and mark id; null: the whole board or a whole view). */
  view: string | null;
  part: string | null;
  /** A dragged box's place (`boxKey`), so a box over no part shows its own; null: none. */
  box: string | null;
  /** The dragged box itself (its comment bubble sits at its corner). */
  boxAt?: ShapeNoteBox | null;
}

/** Where a dragged box sits on its view: the same box asked from again has the same key. */
export function boxKey(view: string | null, box: ShapeNoteBox | null | undefined): string | null {
  return box ? `${view}|${box.x},${box.y},${box.w},${box.h}${box.more ? '|more' : ''}` : null;
}

/** The entries on one part or box (its box), or every one (the whole board's). */
export function talkOn(entries: readonly ShapeTalkEntry[], on: { view: string | null; part: string | null; box?: string | null } | null): ShapeTalkEntry[] {
  if (!on) return entries.slice();
  return entries.filter((e) => (e.part !== null && e.view === on.view && e.part === on.part) || (!!on.box && e.box === on.box));
}

/** `who`: who answers an Ask; `whoAlways`: said before any question too (the session ended: what happens to one). */
export function ShapeTalk({ entries, who, whoAlways = false, onCode }: { entries: readonly ShapeTalkEntry[]; who: string | null; whoAlways?: boolean; onCode: (path: string, line: number) => void }) {
  if (entries.length === 0 && !(whoAlways && who)) return null;
  return (
    <div
      className="shp-talk"
      data-shape-talk=""
      onClickCapture={(e) => {
        // A `code:path#L12` link in an answer opens the code there.
        const a = (e.target as Element).closest('a');
        const m = a?.getAttribute('href')?.match(/^code:([^#]+)#L(\d+)/);
        if (m) {
          e.preventDefault();
          onCode(m[1]!, Number(m[2]));
        }
      }}
    >
      {who && <p className="shp-talk-who">{who}</p>}
      {entries.map((e) => (
        <article key={e.id} className="shp-talk-entry" data-shape-talk-entry={e.id}>
          <p className="shp-talk-where">{e.label}</p>
          <p className="shp-talk-q">{e.change ? `Change: ${e.words}` : e.words}</p>
          {e.error ? (
            <p className="shp-talk-error" role="alert">{e.error}</p>
          ) : e.answer ? (
            <div className="shp-talk-a" aria-live={e.streaming ? 'polite' : undefined}>{renderChatMarkdown(e.answer)}</div>
          ) : e.streaming ? (
            <p className="shp-talk-wait" role="status"><Pebble alive reshaping size={13} />Answering…</p>
          ) : e.status ? (
            <p className="shp-talk-status">{e.status}</p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/**
 * A box to read what was asked and changed, with no words to type (a finished board; a comment bubble on a box): the
 * talk with its place, and a close. It stays inside the board (`within`), by what opened it, as the comment box does.
 * Esc or the × closes it and gives the focus back to what opened it; a press outside closes it where the press went.
 * One Esc closes one thing: an Esc something else already used (the board's References panel) leaves it open.
 */
export function ShapeTalkBox({ anchor, within, label, onClose, children }: { anchor: HTMLElement; within: HTMLElement | null; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const window_ = useVisibleViewportBounds(16);
  const [at, setAt] = useState<ReturnType<typeof sheetWithin> | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const closeBack = () => {
    close.current();
    // What opened it, if it is still there and takes the focus (a part, a bubble, Global comment).
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const place = () => {
      const bounds = boundsWithin(window_, within);
      const next = computeCommentPopoverPosition(anchor.getBoundingClientRect(), bounds);
      setAt(next.requiresExpanded ? sheetWithin(bounds) : next);
    };
    place();
    window.addEventListener('scroll', place, true);
    return () => window.removeEventListener('scroll', place, true);
  }, [anchor, within, window_]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      closeBack();
    };
    const away = (e: PointerEvent) => {
      if (!e.composedPath().some((t) => t === ref.current || t === anchor)) close.current();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', away, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      className="shp-talkbox"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-comment-popover=""
      data-shape-talkbox=""
      style={at ? { top: at.top, left: at.left, width: at.width, maxHeight: at.maxHeight, ...(at.flipAbove ? { transform: 'translateY(-100%)' } : {}) } : { visibility: 'hidden' }}
    >
      <div className="shp-talkbox-head">
        <span>{label}</span>
        <button type="button" className="shp-icon-btn" onClick={closeBack} aria-label="Close">×</button>
      </div>
      {children}
    </div>,
    document.body,
  );
}
