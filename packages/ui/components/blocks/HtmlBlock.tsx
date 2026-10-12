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

  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    // A host's resolver (RenderedMarkdown `resolveImage`) decides first, as
    // InlineMarkdown does; null keeps the default resolution below.
    const resolved = resolveImage ? resolveImage(src) : null;
    if (resolved?.kind === 'unavailable') {
      const placeholder = img.ownerDocument.createElement('span');
      placeholder.className = UNAVAILABLE_IMAGE_CLASS;
      placeholder.title = resolved.title;
      placeholder.setAttribute('data-image-unavailable', '');
      placeholder.textContent = img.getAttribute('alt') || 'Image';
      img.replaceWith(placeholder);
      return;
    }
    if (resolved?.kind === 'src') {
      img.setAttribute('src', resolved.src);
      return;
    }
    if (/^(https?:|data:|blob:)/i.test(src)) return;
    img.setAttribute('src', getImageSrc(src, imageBaseDir));
  });

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
    if (ref.current.innerHTML !== sanitized) {
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
