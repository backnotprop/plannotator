/**
 * The Search tip's card (rules in searchTip.ts): the Launch tip's card (`.ib-tour-coach.ib-ctip`, LaunchTipCard.tsx),
 * drawn inside the palette's `<dialog>` (a portal to the body would sit under the backdrop, inert): beside the palette
 * level with the box, or under the box in the palette's flow. It never takes focus: Got it keeps focus in the box on a
 * press, and on a keyboard press sends it back there.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { SEARCH_TIP_WORDS, searchTipPlace, type SearchTipPlace } from './searchTip';

export function SearchTipCard(props: {
  phone: boolean;
  leaving: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  rowRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  lineId: string;
  /** Got it. `keyboard`: the button had focus (it was pressed from the keyboard). */
  onOk: (keyboard: boolean) => void;
}) {
  const { leaving, phone, dialogRef, rowRef } = props;
  const okRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<SearchTipPlace | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const dialog = dialogRef.current;
      const row = rowRef.current;
      if (!dialog || !row) return;
      setPlace(searchTipPlace({ phone, viewportWidth: window.innerWidth, dialog: dialog.getBoundingClientRect(), row: row.getBoundingClientRect() }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [phone, dialogRef, rowRef]);
  const side = place?.side ?? 'below';
  return (
    <div
      className="ib-tour-coach ib-ctip"
      role="group"
      aria-labelledby={props.titleId}
      aria-hidden={leaving || undefined}
      data-search-tip=""
      data-side={side}
      data-leaving={leaving ? '' : undefined}
      style={place?.side === 'right' ? { top: place.top, left: place.left } : place ? undefined : { visibility: 'hidden' }}
    >
      <span className="ib-ctip-arrow" data-side={side === 'right' ? 'left' : 'up'} aria-hidden="true" />
      <div className="ib-tc-eb">{SEARCH_TIP_WORDS.eyebrow}</div>
      <h2 id={props.titleId}>{SEARCH_TIP_WORDS.title}</h2>
      <p id={props.lineId}>{SEARCH_TIP_WORDS.line}</p>
      <div className="ib-tc-acts">
        <button
          ref={okRef}
          type="button"
          className="ib-tc-next"
          data-search-tip-ok=""
          tabIndex={leaving ? -1 : undefined}
          // A pointer press never takes focus from the box.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onOk(document.activeElement === okRef.current)}
        >
          {SEARCH_TIP_WORDS.ok}
        </button>
      </div>
    </div>
  );
}
