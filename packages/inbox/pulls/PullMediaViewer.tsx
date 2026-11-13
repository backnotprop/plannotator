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
  // Capture phase, so the Details panel's and App's Escape see it used.
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
