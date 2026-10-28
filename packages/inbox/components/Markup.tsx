import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { ImageAttachment } from '@plannotator/ui/types';
import { Icon } from '../icons';
import { Tip } from './Tip';
import type { InboxToastModel } from './Toast';

/** The window's toast, as the thread hands it down. */
export type Notice = (toast: Omit<InboxToastModel, 'id'>) => void;

/**
 * ui `ImageAnnotator`'s Inbox props (the owner's answer, 2026-10-26): Escape
 * cancels and keeps nothing, Enter or the ✓ adds the drawing to the reply, and
 * a click outside closes only an empty drawing, so a stray click never loses
 * one. The line under the drawing says so. Plan review keeps its own rule.
 */
export const DRAWING_SCREEN = {
  escapeCancels: true,
  hint: (
    <>
      <kbd className="ib-markkey">Enter</kbd> or ✓ adds to your reply · <kbd className="ib-markkey">Esc</kbd> cancels
    </>
  ),
} as const;

/**
 * The drawing screen over the whole window: beside the thread it sat inside
 * the pane, under the thread column (the left of a wide image was covered, and
 * a stroke there selected the thread's words), and on a phone under the
 * full-screen toolbar. Portaled into `.pn-inbox` so the theme still applies.
 */
export function OverWindow({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  const host = document.querySelector('.pn-inbox') ?? document.body;
  return createPortal(children, host);
}

/** "Markup added to your reply · Undo": the window's toast, its Undo (and Z, where the toast takes it) removing the comment. */
export function markupAddedToast(onUndo: () => void): Omit<InboxToastModel, 'id'> {
  return { icon: 'check', lead: 'Markup added to your reply', speech: 'Markup added to your reply.', onUndo };
}

/**
 * The drawing the ✓ just added to the reply, in the comment box: its picture
 * with a check (a click draws again, replacing it in the same comment) and ×
 * (takes it out of the reply). Words typed beside it go onto the same comment.
 */
export function KeptMarkup({ image, onRedraw, onRemove, wide = false }: { image: ImageAttachment; onRedraw: () => void; onRemove: () => void; wide?: boolean }) {
  return (
    <span className={`ib-kept${wide ? ' ib-kept-wide' : ''}`} data-markup-kept="">
      <Tip content="In your reply · Draw again">
        <button type="button" className="ib-kept-img" onClick={onRedraw} aria-label="Your drawing is in your reply. Draw again" data-markup-redraw="">
          <img src={getImageSrc(image.path)} alt="" />
          <span className="ib-kept-ok" aria-hidden="true">
            <Icon name="check" size={9} />
          </span>
        </button>
      </Tip>
      <Tip content="Remove from your reply">
        <button type="button" className="ib-kept-x" onClick={onRemove} aria-label="Remove the drawing from your reply" data-markup-remove="">
          <Icon name="x" size={10} />
        </button>
      </Tip>
    </span>
  );
}

/** A drawing that has no words, as its card's body (in place of the stand-in words). */
export function MarkupPicture({ image }: { image: ImageAttachment }) {
  return (
    <span className="ib-markpic" data-markup-picture="">
      <img src={getImageSrc(image.path)} alt={image.name} />
    </span>
  );
}
