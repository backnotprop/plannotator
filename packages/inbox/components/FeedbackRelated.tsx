/// <reference path="../assets.d.ts" />
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { relatedIndex, relatedLinks, type RelatedData, type RelatedIndex, type RelatedLink } from '../feedbackRelated';

/** How long after the last keystroke the list may change. */
export const RELATED_PAUSE_MS = 500;
/** Below the dialog's foot, when the pinned dialog is taller than what is left of the window. */
const FOOT_ROOM = 16;
/** Above the box in the sheet over a keyboard, once the title has scrolled away. */
const BOX_HEAD = 4;

/**
 * Parsed at the first open: `?raw` keeps the file a string in the page, so a
 * window that never opens the form holds none of its objects (#2593). In the
 * single-file build it is already in the page: no request.
 */
let loading: Promise<RelatedIndex> | null = null;
function loadRelatedIndex(): Promise<RelatedIndex> {
  loading ??= import('../feedbackRelated.data.json?raw').then((file) => relatedIndex(JSON.parse(file.default) as RelatedData));
  return loading;
}

/**
 * Stops the centered dialog from following its own height, so the box stays
 * under the caret and the dialog grows downward only. Read before the list is
 * drawn: once it is, centering has already moved the dialog.
 */
function pin(dialog: HTMLElement): void {
  const { top } = dialog.getBoundingClientRect();
  dialog.style.marginTop = `${top}px`;
  dialog.style.marginBottom = 'auto';
  dialog.style.maxHeight = `calc(100dvh - ${top + FOOT_ROOM}px)`;
}

function unpin(dialog: HTMLElement): void {
  dialog.style.removeProperty('margin-top');
  dialog.style.removeProperty('margin-bottom');
  dialog.style.removeProperty('max-height');
}

/** A pointer resting on the buttons. A touch screen has none: its `:hover` sticks after a tap, and its sheet keeps the buttons in place anyway. */
function pointerRestsOn(element: HTMLElement | null): element is HTMLElement {
  return !!element && window.matchMedia('(hover: hover)').matches && element.matches(':hover');
}

const keyboardIsUp = () => document.documentElement.hasAttribute('data-ib-keyboard');

/** A phone's keyboard (phone.ts trackKeyboard marks the page): followed only in the sheet. */
function useKeyboardUp(phone: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!phone) {
      setUp(false);
      return;
    }
    const read = () => setUp(keyboardIsUp());
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ib-keyboard'] });
    return () => watch.disconnect();
  }, [phone]);
  return up;
}

/**
 * The lines for what is typed, changed only after a pause: the old lines stay
 * while the person types, so the form does not flicker. Nothing here makes a
 * request. If the file cannot be read there are no lines and the form is
 * today's.
 */
export function useFeedbackRelated(options: {
  message: string;
  /** Sending or sent: nothing moves any more. */
  frozen: boolean;
  phone: boolean;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  actionsRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
}): RelatedLink[] {
  const { message, frozen, phone, boxRef, actionsRef, listRef } = options;
  const [index, setIndex] = useState<RelatedIndex | null>(null);
  const [links, setLinks] = useState<RelatedLink[]>([]);
  const pinned = useRef<HTMLElement | null>(null);
  const keyboardUp = useKeyboardUp(phone);

  useEffect(() => {
    let current = true;
    void loadRelatedIndex().then(
      (loaded) => {
        if (current) setIndex(loaded);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (frozen || !index) return;
    let stopWaiting = () => {};
    const show = () => {
      const next = relatedLinks(index, message);
      const dialog = boxRef.current?.closest('dialog') ?? null;
      if (next.length && !phone && dialog && !pinned.current) {
        pin(dialog);
        pinned.current = dialog;
      }
      setLinks(next);
    };
    const timer = setTimeout(() => {
      const actions = actionsRef.current;
      const list = listRef.current;
      if (list?.contains(document.activeElement)) {
        // A focused link must not vanish: focus would fall to the page. Tabbing to the next link is still inside.
        const left = (event: FocusEvent) => {
          if (list.contains(event.relatedTarget as Node | null)) return;
          list.removeEventListener('focusout', left);
          show();
        };
        list.addEventListener('focusout', left);
        stopWaiting = () => list.removeEventListener('focusout', left);
      } else if (pointerRestsOn(actions)) {
        // Send must not move under a pointer about to press it.
        actions.addEventListener('pointerleave', show, { once: true });
        stopWaiting = () => actions.removeEventListener('pointerleave', show);
      } else show();
    }, RELATED_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      stopWaiting();
    };
  }, [message, frozen, index, phone, boxRef, actionsRef, listRef]);

  // Over a keyboard the sheet has room for one line and Send, not three. The rest come back with the room.
  const shown = keyboardUp ? links.slice(0, 1) : links;

  // The title yields as the keyboard rises, not when a line shows: the box is under the caret and stays there.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const dialog = box?.closest('dialog');
    if (!keyboardUp || !box || !dialog) return;
    const settle = () => {
      dialog.scrollTop += box.getBoundingClientRect().top - dialog.getBoundingClientRect().top - BOX_HEAD;
    };
    if (document.activeElement === box) settle();
    box.addEventListener('focus', settle);
    return () => box.removeEventListener('focus', settle);
  }, [keyboardUp, boxRef]);

  // Another window size, or a phone's sheet: centering and the sheet's own rules apply again.
  useEffect(() => {
    const release = () => {
      if (pinned.current) unpin(pinned.current);
      pinned.current = null;
    };
    if (phone) release();
    window.addEventListener('resize', release);
    return () => window.removeEventListener('resize', release);
  }, [phone]);

  return shown;
}

/** Always in the DOM so a screen reader hears the lines arrive; empty, it takes no room. */
export function FeedbackRelated({ links, listRef }: { links: RelatedLink[]; listRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="ib-fbk-rel" role="status" data-feedback-related="" ref={listRef}>
      {links.length > 0 && (
        <>
          <p className="ib-fbk-rel-h">Might be related</p>
          <ul>
            {links.map((link) => (
              <li key={link.href + link.title}>
                <span>
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.title}
                  </a>
                  {/[…?!]$/.test(link.title) ? ' ' : '. '}
                  {link.reason}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
