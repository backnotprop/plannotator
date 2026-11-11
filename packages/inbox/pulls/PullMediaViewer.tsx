/**
 * One of a pull request's own pictures or videos, full screen in the attachment viewer (the one a thread's files open
 * in: zoom, seeking, the player's own full screen). Read only: nothing is kept or sent from here, so the comment row
 * is not offered. Drawn into the window's root, over the page or the Details panel that opened it; × or Escape closes
 * it and focus goes back to what opened it.
 */
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AttachmentPane } from '../components/AttachmentPane';
import { InboxFileSourceProvider } from '../fileSource';
import { usePhone } from '../phone';
import { inOverlay, isComposingKey } from '../shortcuts/guards';
import { pullMediaAttachment, pullMediaSource, type PullMediaItem } from './pullMedia';

const noop = () => {};

export function PullMediaViewer({ pullKey, item, onClose }: { pullKey: string; item: PullMediaItem; onClose: () => void }) {
  const phone = usePhone();
  const source = useMemo(() => pullMediaSource(pullKey), [pullKey]);
  const attachment = useMemo(() => pullMediaAttachment(item), [item]);
  const attachments = useMemo(() => [attachment], [attachment]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Escape closes the viewer first: ahead of the Details panel's and App's own Escape, which see it used.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      const from = event.target instanceof Element ? event.target : null;
      if (from && inOverlay(from) && !from.closest('[data-pull-media-viewer]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const root = typeof document === 'undefined' ? null : (document.querySelector('.pn-inbox') ?? document.body);
  if (!root) return null;
  return createPortal(
    <div data-pull-media-viewer="" style={{ display: 'contents' }}>
      <InboxFileSourceProvider source={source}>
        <AttachmentPane
          attachment={attachment}
          attachments={attachments}
          records={[]}
          agent=""
          projectName=""
          projectRoot=""
          version="current"
          onVersion={noop}
          full
          fullLocked
          exitCloses
          phone={phone}
          onToggleFull={() => closeRef.current()}
          focusId={null}
          focusRequest={1}
          readOnly
          onSaved={noop}
          onRemoved={noop}
          onOpenAt={noop}
          onClose={() => closeRef.current()}
          strip={{ picks: 0, annotations: 0, onWriteReply: () => closeRef.current() }}
        />
      </InboxFileSourceProvider>
    </div>,
    root,
  );
}
