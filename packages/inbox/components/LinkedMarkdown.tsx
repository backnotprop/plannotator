import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { LinkedPageView } from '../api';
import { attachmentBlocks } from '../attachments';
import { inboxMarkdownImageBase } from '../images';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

/** Sibling documents are read-only: annotations belong to attached files. */
export function LinkedMarkdown({ page, attachmentId, onOpenLink }: {
  page: LinkedPageView & { html: null; text: string; relative: string; hash: string };
  attachmentId: string;
  onOpenLink: (href: string) => void;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const blocks = useMemo(() => attachmentBlocks('markdown', page.text, page.name), [page.text, page.name]);
  // Its own images, relative to its folder and only those it references (the attachment's markdown-image route).
  const imageBaseDir = inboxMarkdownImageBase(attachmentId, 'current', page.relative);
  const resolveImage = useCallback<ImageResolver>(
    (src) => ({ kind: 'src', src: /^(https?:|data:|blob:)/i.test(src) ? src : getImageSrc(src, imageBaseDir) }),
    [imageBaseDir],
  );
  // Stable across renders (through a ref): ui's HtmlBlock redraws a raw HTML block whenever its link resolver changes.
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  const resolveLocalLink = useCallback<LocalLinkResolver>((href) => ({ kind: 'open', open: () => openLinkRef.current(href) }), []);
  useEffect(() => {
    if (!viewport || !page.hash) return;
    viewer.current?.scrollToAnchor?.(page.hash);
  }, [viewport, page.hash, page.path]);
  return (
    <div className="ib-docscroll ib-linkeddoc bg-card" data-look="clean" ref={setViewport}>
      <ScrollViewportProvider viewport={viewport}>
        <ImageResolverContext.Provider value={resolveImage}>
          <Viewer
            key={page.path}
            ref={viewer}
            blocks={blocks}
            markdown={page.text}
            imageBaseDir={imageBaseDir}
            annotations={NO_ANNOTATIONS}
            onAddAnnotation={noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            resolveLocalLink={resolveLocalLink}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            maxWidth={760}
            mode="comment"
            taterMode={false}
            readOnly
          />
        </ImageResolverContext.Provider>
      </ScrollViewportProvider>
    </div>
  );
}
