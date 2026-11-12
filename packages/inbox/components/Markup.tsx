import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { ImageAttachment } from '@plannotator/ui/types';
import { Icon } from '../icons';
import { Tip } from './Tip';
import type { InboxToastModel } from './Toast';

export type Notice = (toast: Omit<InboxToastModel, 'id'>) => void;

export const DRAWING_SCREEN = {
  escapeCancels: true,
  hint: (
    <>
      <kbd className="ib-markkey">Enter</kbd> or ✓ adds to your reply · <kbd className="ib-markkey">Esc</kbd> cancels
    </>
  ),
} as const;

export function OverWindow({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  const host = document.querySelector('.pn-inbox') ?? document.body;
  return createPortal(children, host);
}

export function markupAddedToast(onUndo: () => void): Omit<InboxToastModel, 'id'> {
  return { icon: 'check', lead: 'Markup added to your reply', phoneLead: 'Added to your reply', speech: 'Markup added to your reply.', onUndo };
}

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

export function MarkupPicture({ image }: { image: ImageAttachment }) {
  return (
    <span className="ib-markpic" data-markup-picture="">
      <img src={getImageSrc(image.path)} alt={image.name} />
    </span>
  );
}
