import { useEffect, useRef, useState, type RefObject } from 'react';
import { relatedIndex, relatedLinks, type RelatedData, type RelatedIndex, type RelatedLink } from '../feedbackRelated';

/** How long after the last keystroke the list may change. */
export const RELATED_PAUSE_MS = 500;
/** Below the dialog's foot, when the pinned dialog is taller than what is left of the window. */
const FOOT_ROOM = 16;

/** Indexed at the first open, not for a window that never opens the form. In the single-file build the file is already in the page: no request. */
let loading: Promise<RelatedIndex> | null = null;
function loadRelatedIndex(): Promise<RelatedIndex> {
  loading ??= import('../feedbackRelated.data.json').then((data) => relatedIndex(data.default as RelatedData));
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
}): RelatedLink[] {
  const { message, frozen, phone, boxRef, actionsRef } = options;
  const [index, setIndex] = useState<RelatedIndex | null>(null);
  const [links, setLinks] = useState<RelatedLink[]>([]);
  const pinned = useRef<HTMLElement | null>(null);

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
    let actions: HTMLElement | null = null;
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
      // Send must not move under a pointer about to press it.
      if (pointerRestsOn(actionsRef.current)) {
        actions = actionsRef.current;
        actions.addEventListener('pointerleave', show, { once: true });
      } else show();
    }, RELATED_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      actions?.removeEventListener('pointerleave', show);
    };
  }, [message, frozen, index, phone, boxRef, actionsRef]);

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

  return links;
}

/** Always in the DOM so a screen reader hears the lines arrive; empty, it takes no room. */
export function FeedbackRelated({ links }: { links: RelatedLink[] }) {
  return (
    <div className="ib-fbk-rel" role="status" data-feedback-related="">
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
