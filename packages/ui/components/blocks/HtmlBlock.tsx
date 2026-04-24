import React, { useRef, useEffect } from "react";
import { Block } from "../../types";
import { sanitizeBlockHtml } from "../../utils/sanitizeHtml";
import { getImageSrc } from "../ImageThumbnail";

interface HtmlBlockProps {
  block: Block;
  imageBaseDir?: string;
  onOpenLinkedDoc?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
}

// Walks the sanitized DOM and rewrites relative <img src> / <a href> so they
// behave the same as their markdown counterparts:
// - Relative image paths route through /api/image?path=... so they load from
//   the plan's directory, not the plannotator server root.
// - Relative .md / .mdx / .html links open in the linked-doc overlay when
//   onOpenLinkedDoc is provided (same as [[wiki-links]] and [label](./x.md)).
// Absolute http(s) URLs and mailto: are left untouched.
function rewriteRelativeRefs(
  root: HTMLElement,
  imageBaseDir?: string,
  onOpenLinkedDoc?: (path: string) => void,
  onNavigateAnchor?: (hash: string) => void,
): (() => void) {
  const cleanups: (() => void)[] = [];

  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
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
    if (onOpenLinkedDoc && /\.(mdx?|html?)(#.*)?$/i.test(href)) {
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
const HtmlBlockImpl: React.FC<HtmlBlockProps> = ({ block, imageBaseDir, onOpenLinkedDoc, onNavigateAnchor }) => {
  const ref = useRef<HTMLDivElement>(null);
  const sanitized = React.useMemo(
    () => sanitizeBlockHtml(block.content),
    [block.content],
  );
  useEffect(() => {
    if (!ref.current) return;
    if (ref.current.innerHTML !== sanitized) {
      ref.current.innerHTML = sanitized;
    }
    const cleanup = rewriteRelativeRefs(ref.current, imageBaseDir, onOpenLinkedDoc, onNavigateAnchor);
    return cleanup;
  }, [sanitized, imageBaseDir, onOpenLinkedDoc, onNavigateAnchor]);
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
    prev.onNavigateAnchor === next.onNavigateAnchor,
);
