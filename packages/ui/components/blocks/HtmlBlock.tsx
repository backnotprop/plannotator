import React, { useRef, useEffect } from "react";
import { isCodeFilePath } from "@plannotator/core/code-file";
import type { Block } from "../../types";
import { sanitizeBlockHtml } from "../../utils/sanitizeHtml";
import { getImageSrc } from "../ImageThumbnail";
import { UNAVAILABLE_IMAGE_CLASS, useImageResolver, type ImageResolver } from "../ImageResolverContext";
import { isLocalLinkTarget, isNewTabClick, useLocalLinkResolver, type LocalLinkResolver } from "../LocalLinkContext";

interface HtmlBlockProps {
  block: Block;
  imageBaseDir?: string;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
}

function unavailableMedia(doc: Document, label: string, title: string): HTMLSpanElement {
  const placeholder = doc.createElement('span');
  placeholder.className = UNAVAILABLE_IMAGE_CLASS;
  placeholder.title = title;
  placeholder.setAttribute('data-image-unavailable', '');
  placeholder.textContent = label;
  return placeholder;
}

/**
 * With a host image resolver (RenderedMarkdown `resolveImage`), every media
 * URL is the host's call, decided on an INERT copy before anything is in the
 * document, so nothing is fetched from the page origin first:
 * - `<img src>` goes through the resolver (`src`, or a placeholder); its
 *   `srcset` / `sizes` are dropped, so the browser cannot pick a candidate
 *   the host never saw.
 * - `<picture><source>` is dropped; the `<img>` inside is the fallback.
 * - `<video>` (with its `src`, `poster` and `<source>`s) becomes a
 *   placeholder: the resolver speaks for images only.
 */
function resolveHostMedia(root: DocumentFragment, doc: Document, resolveImage: ImageResolver): void {
  root.querySelectorAll('video').forEach((video) => {
    video.replaceWith(unavailableMedia(doc, 'Video', 'Videos are not shown here'));
  });
  root.querySelectorAll('picture source').forEach((source) => source.remove());
  root.querySelectorAll('img').forEach((img) => {
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    const src = img.getAttribute('src');
    const alt = img.getAttribute('alt') || 'Image';
    if (!src) {
      img.replaceWith(unavailableMedia(doc, alt, 'Image has no source'));
      return;
    }
    const resolved = resolveImage(src);
    if (resolved?.kind === 'unavailable') {
      img.replaceWith(unavailableMedia(doc, alt, resolved.title));
      return;
    }
    if (resolved?.kind === 'src') {
      img.setAttribute('src', resolved.src);
    } else if (!/^(https?:|data:|blob:)/i.test(src)) {
      img.setAttribute('src', getImageSrc(src));
    }
    img.setAttribute('data-host-image', '');
  });
}

const IMAGE_NOT_FOUND_TITLE = 'Image could not be loaded';

// Walks the sanitized DOM and rewrites relative <img src> / <a href> so they
// behave the same as their markdown counterparts:
// - Relative image paths route through /api/image?path=... so they load from
//   the plan's directory, not the plannotator server root.
// - Relative .md / .mdx / .txt / .html links open in the linked-doc overlay when
//   onOpenLinkedDoc is provided (same as [[wiki-links]] and [label](./x.md)).
// Absolute http(s) URLs and mailto: are left untouched.
function rewriteRelativeRefs(
  root: HTMLElement,
  imageBaseDir?: string,
  onOpenLinkedDoc?: (path: string) => void,
  onOpenCodeFile?: (path: string) => void,
  onNavigateAnchor?: (hash: string) => void,
  resolveLocalLink?: LocalLinkResolver | null,
  resolveImage?: ImageResolver | null,
): (() => void) {
  const cleanups: (() => void)[] = [];

  if (resolveImage) {
    // Media was already decided by the host before insertion (see
    // resolveHostMedia); only the load-failure fallback is wired here.
    root.querySelectorAll<HTMLImageElement>('img[data-host-image]').forEach((img) => {
      const onError = () => img.replaceWith(unavailableMedia(img.ownerDocument, img.getAttribute('alt') || 'Image', IMAGE_NOT_FOUND_TITLE));
      img.addEventListener('error', onError);
      cleanups.push(() => img.removeEventListener('error', onError));
    });
  } else {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      if (/^(https?:|data:|blob:)/i.test(src)) return;
      img.setAttribute('src', getImageSrc(src, imageBaseDir));
    });
  }

  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    // External http(s) links: open in a new tab and close the tab-nabbing
    // vector (opener reference back to the plannotator tab). Matches the
    // markdown renderer's behavior for [label](https://...).
    if (/^(https?:|\/\/)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return;
    }
    if (/^(mailto:|tel:)/i.test(href)) return;
    // In-page anchor: native browser jump doesn't target the scroll viewport,
    // so route through onNavigateAnchor to match InlineMarkdown's behavior.
    if (href.startsWith('#')) {
      if (!onNavigateAnchor) return;
      const handler = (e: Event) => {
        e.preventDefault();
        onNavigateAnchor(href);
      };
      a.addEventListener('click', handler);
      cleanups.push(() => a.removeEventListener('click', handler));
      return;
    }
    // A host's resolver (Viewer `resolveLocalLink`) decides local paths
    // first, as InlineMarkdown does; null keeps the rules below.
    const localLink = resolveLocalLink && isLocalLinkTarget(href) ? resolveLocalLink(href) : null;
    if (localLink?.kind === 'open') {
      const openLink = localLink.open;
      const hostHref = localLink.href;
      const handler = (e: Event) => {
        // With the host's own address, a new-tab click goes there.
        if (hostHref && e instanceof MouseEvent && isNewTabClick(e)) return;
        e.preventDefault();
        e.stopPropagation();
        openLink();
      };
      if (hostHref) {
        a.setAttribute('href', hostHref);
        a.removeAttribute('target');
      }
      if (localLink.title) a.setAttribute('title', localLink.title);
      a.setAttribute('data-local-link', 'open');
      // Without it, a middle click would open the path on the host's own origin.
      const aux = (e: Event) => {
        if (!hostHref) e.preventDefault();
      };
      a.addEventListener('click', handler);
      a.addEventListener('auxclick', aux);
      cleanups.push(() => {
        a.removeEventListener('click', handler);
        a.removeEventListener('auxclick', aux);
      });
      return;
    }
    if (localLink?.kind === 'unavailable') {
      // Inert: without an href the browser neither follows nor fetches it.
      a.removeAttribute('href');
      a.removeAttribute('target');
      a.setAttribute('title', localLink.title);
      a.setAttribute('data-local-link', 'unavailable');
      return;
    }
    if (onOpenCodeFile && isCodeFilePath(href)) {
      const handler = (e: Event) => {
        e.preventDefault();
        onOpenCodeFile(href.replace(/#.*$/, ''));
      };
      a.addEventListener('click', handler);
      cleanups.push(() => a.removeEventListener('click', handler));
      return;
    }
    if (onOpenLinkedDoc && /\.(mdx?|txt|html?)(#.*)?$/i.test(href)) {
      const handler = (e: Event) => {
        e.preventDefault();
        onOpenLinkedDoc(href.replace(/#.*$/, ''));
      };
      a.addEventListener('click', handler);
      cleanups.push(() => a.removeEventListener('click', handler));
    }
  });

  return () => cleanups.forEach((fn) => fn());
}

// The inner HTML is set imperatively (not via dangerouslySetInnerHTML) so that
// React's reconciliation never replaces the rendered subtree on re-render.
// That matters because <details open> is DOM-owned state — a stray innerHTML
// re-set on every parent re-render would collapse any open <details> the
// user just opened. Paired with React.memo below so the component itself
// stops re-rendering unless the block content actually changes.
const HtmlBlockImpl: React.FC<HtmlBlockProps> = ({ block, imageBaseDir, onOpenLinkedDoc, onOpenCodeFile, onNavigateAnchor }) => {
  const ref = useRef<HTMLDivElement>(null);
  const resolveLocalLink = useLocalLinkResolver();
  const resolveImage = useImageResolver();
  const sanitized = React.useMemo(
    () => sanitizeBlockHtml(block.content),
    [block.content],
  );
  useEffect(() => {
    if (!ref.current) return;
    if (resolveImage) {
      // Decide every media URL on an inert template first (nothing loads
      // there), then insert the result.
      const template = ref.current.ownerDocument.createElement('template');
      template.innerHTML = sanitized;
      resolveHostMedia(template.content, ref.current.ownerDocument, resolveImage);
      ref.current.replaceChildren(template.content);
    } else if (ref.current.innerHTML !== sanitized) {
      ref.current.innerHTML = sanitized;
    }
    const cleanup = rewriteRelativeRefs(ref.current, imageBaseDir, onOpenLinkedDoc, onOpenCodeFile, onNavigateAnchor, resolveLocalLink, resolveImage);
    return cleanup;
  }, [sanitized, imageBaseDir, onOpenLinkedDoc, onOpenCodeFile, onNavigateAnchor, resolveLocalLink, resolveImage]);
  return (
    <div
      ref={ref}
      data-block-id={block.id}
      data-block-type="html"
      className="html-block my-4 text-[15px] leading-relaxed text-foreground/90"
    />
  );
};
export const HtmlBlock = React.memo(
  HtmlBlockImpl,
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.imageBaseDir === next.imageBaseDir &&
    prev.onOpenLinkedDoc === next.onOpenLinkedDoc &&
    prev.onOpenCodeFile === next.onOpenCodeFile &&
    prev.onNavigateAnchor === next.onNavigateAnchor,
);
