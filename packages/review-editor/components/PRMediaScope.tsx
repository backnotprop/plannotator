import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { mediaArtifact } from '../utils/prMediaTarget';

const MEDIA_ATTR = 'data-pr-media';
const ARTIFACT_ID_ATTR = 'data-pr-artifact-id';
export const PR_MEDIA_SKIP_ATTR = 'data-pr-media-skip';

function isShown(img: HTMLImageElement): boolean {
  return !img.hidden && img.style.display !== 'none' && !img.hasAttribute('data-image-failed');
}

function clearMedia(element: HTMLElement): void {
  if (!element.hasAttribute(MEDIA_ATTR)) return;
  element.removeAttribute(MEDIA_ATTR);
  element.removeAttribute(ARTIFACT_ID_ATTR);
  if (element.tagName === 'IMG') {
    element.removeAttribute('role');
    element.removeAttribute('tabindex');
    element.removeAttribute('aria-label');
  }
  element.removeAttribute('title');
}

// Marks rendered elements with attributes only (never moves a node): the text belongs to the renderer and highlighter.
export function PRMediaScope({ children }: { children: React.ReactNode }): React.JSX.Element {
  const state = useReviewStateOptional();
  const ref = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const artifacts = state?.prArtifacts;
  const metadata = state?.prMetadata ?? null;
  const openPRArtifact = state?.openPRArtifact;
  const enabled = metadata !== null && openPRArtifact !== undefined;

  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled || !artifacts) return;
    const decorate = (): void => {
      for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
        const artifact = isShown(img) ? mediaArtifact(img, artifacts, metadata) : null;
        const zoom = artifact === null && isShown(img) && img.closest('a') === null;
        if (artifact === null && !zoom) {
          clearMedia(img);
          if (img.closest('a') !== null) img.classList.remove('cursor-zoom-in');
          continue;
        }
        const label = artifact ? `Open ${artifact.name} in Artifacts` : `View ${img.alt || 'picture'} larger`;
        img.setAttribute(MEDIA_ATTR, artifact ? 'artifact' : 'zoom');
        if (artifact) img.setAttribute(ARTIFACT_ID_ATTR, artifact.id);
        else img.removeAttribute(ARTIFACT_ID_ATTR);
        img.setAttribute('role', 'button');
        img.setAttribute('tabindex', '0');
        img.setAttribute('aria-label', label);
        img.setAttribute('title', artifact ? 'Open in Artifacts' : 'View larger');
        img.classList.add('cursor-zoom-in');
      }
      for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const artifact = link.hasAttribute(PR_MEDIA_SKIP_ATTR) || link.querySelector('img') !== null
          ? null
          : mediaArtifact(link, artifacts, metadata);
        if (artifact === null) {
          clearMedia(link);
          continue;
        }
        link.setAttribute(MEDIA_ATTR, 'artifact');
        link.setAttribute(ARTIFACT_ID_ATTR, artifact.id);
        link.setAttribute('title', 'Open in Artifacts');
      }
    };
    decorate();
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(decorate);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'hidden', 'style', 'data-image-failed'],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [artifacts, enabled, metadata]);

  const activate = (element: HTMLElement): void => {
    const id = element.getAttribute(ARTIFACT_ID_ATTR);
    if (id !== null) {
      openPRArtifact?.(id);
      return;
    }
    if (element instanceof HTMLImageElement) {
      setLightbox({ src: element.currentSrc || element.src, alt: element.alt });
    }
  };

  const target = (event: React.SyntheticEvent): HTMLElement | null => {
    if (!(event.target instanceof Element)) return null;
    const element = event.target.closest<HTMLElement>(`[${MEDIA_ATTR}]`);
    return element !== null && ref.current?.contains(element) ? element : null;
  };

  return (
    <div
      ref={ref}
      // Capture: a markdown image stops its own click from bubbling.
      onClickCapture={(event) => {
        const element = target(event);
        if (element === null) return;
        const isLink = element.tagName === 'A';
        if (isLink && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        event.preventDefault();
        event.stopPropagation();
        activate(element);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const element = target(event);
        if (element === null || element.tagName === 'A' || element !== event.target) return;
        event.preventDefault();
        event.stopPropagation();
        activate(element);
      }}
    >
      {children}
      {lightbox && createPortal(
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />,
        document.body,
      )}
    </div>
  );
}
