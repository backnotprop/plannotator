import React, { useRef, useEffect, useContext } from "react";
import { isCodeFilePath } from "@plannotator/core/code-file";
import type { Block } from "../../types";
import { sanitizeBlockHtml, sanitizedHtmlDrawsNothing } from "../../utils/sanitizeHtml";
import { holdsDroppedHtmlTag, opensDroppedHtmlTag } from "../../utils/inlineHtmlTags";
import { SourceLikeInlineContext } from "../InlineMarkdown";
import { paintAuthorColors } from "../../utils/authorColorContrast";
import { parseSrcset, serializeSrcset, type SrcsetCandidate } from "../../utils/srcset";
import { getImageSrc, usesDefaultImageSrcResolver } from "../ImageThumbnail";
import { UNAVAILABLE_IMAGE_CLASS, PreserveResolvedVideosContext, ResolvedResponsiveImagesContext, useImageResolver, type ImageResolver } from "../ImageResolverContext";
import { isLocalLinkTarget, isNewTabClick, useLocalLinkMatch, useLocalLinkResolver, type LocalLinkResolver } from "../LocalLinkContext";
import { sourceLineAttrs } from "../../utils/sourceLineAttrs";
import { htmlBlockPlayer, htmlBlockPlayersIn, keepHtmlBlockPlayers, wireHtmlBlockPlayers } from "./htmlBlockMedia";

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
 *   With `responsiveImages` (ResolvedResponsiveImagesContext) both are kept
 *   instead, every `srcset` candidate passed through the resolver.
 * - `<video>` (with its `src`, `poster` and `<source>`s) becomes a
 *   placeholder unless the host explicitly preserves videos: the resolver speaks
 *   for images only.
 */
function resolveHostMedia(
  root: DocumentFragment,
  doc: Document,
  resolveImage: ImageResolver,
  preserveVideos: boolean,
  responsiveImages = false,
): void {
  if (!preserveVideos) root.querySelectorAll('video').forEach((video) => {
    video.replaceWith(unavailableMedia(doc, 'Video', 'Videos are not shown here'));
  });
  if (responsiveImages) {
    root.querySelectorAll('img[srcset], picture source[srcset]').forEach((element) => {
      const srcset = resolveSrcset(element.getAttribute('srcset') ?? '', resolveImage);
      if (srcset !== null) {
        element.setAttribute('srcset', srcset);
      } else if (element.tagName === 'SOURCE') {
        element.remove();
      } else {
        element.removeAttribute('srcset');
        element.removeAttribute('sizes');
      }
    });
    root.querySelectorAll('picture source:not([srcset])').forEach((source) => source.remove());
  } else {
    root.querySelectorAll('picture source').forEach((source) => source.remove());
  }
  root.querySelectorAll('img').forEach((img) => {
    if (!responsiveImages) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    }
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
    if (resolved?.kind === 'src' && resolved.media) {
      img.replaceWith(htmlBlockPlayer(doc, resolved.src, img.getAttribute('alt') ?? '', src, resolved.media));
      return;
    }
    if (resolved?.kind === 'src') {
      img.setAttribute('src', resolved.src);
      // A smaller copy of the picture: laid out at the original's width, unless the HTML sized it itself.
      if (resolved.width && !img.hasAttribute('width') && !img.hasAttribute('height')) img.setAttribute('width', String(resolved.width));
    } else if (!/^(https?:|data:|blob:)/i.test(src)) {
      img.setAttribute('src', getImageSrc(src));
    }
    img.setAttribute('data-host-image', '');
  });
}

/**
 * A `srcset` with every candidate URL put through the host's resolver (its
 * descriptors kept), or null when the resolver calls one `unavailable`, so the
 * browser never picks a candidate the host refused. A relative candidate the
 * resolver leaves alone loads like a relative `<img src>`. Candidates are split
 * the way the browser splits them (`parseSrcset`), so a `data:` URL's comma
 * stays inside its URL.
 */
function resolveSrcset(srcset: string, resolveImage: ImageResolver): string | null {
  const candidates: SrcsetCandidate[] = [];
  for (const { url, descriptors } of parseSrcset(srcset)) {
    const resolved = resolveImage(url);
    if (resolved?.kind === 'unavailable') return null;
    const src = resolved?.kind === 'src'
      ? resolved.src
      : /^(https?:|data:|blob:)/i.test(url) ? url : getImageSrc(url);
    candidates.push({ url: src, descriptors });
  }
  return candidates.length > 0 ? serializeSrcset(candidates) : null;
}

const IMAGE_NOT_FOUND_TITLE = 'Image could not be loaded';

// Local media URLs of a block no host resolver decides, rewritten on the
// inert template before insertion (so the written HTML is known, and a re-run
// that would write the same HTML leaves the live DOM, and a playing video, alone):
// - Relative image paths route through /api/image?path=... so they load from
//   the plan's directory, not the plannotator server root.
function rewriteLocalMediaUrls(root: ParentNode, imageBaseDir?: string): void {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) return;
    img.setAttribute('src', getImageSrc(src, imageBaseDir));
  });
  // A local video beside the document plays through the annotate and plan
  // servers' `/api/annotate-media` (Range, so it seeks); a host with its own
  // image resolver has no such route, so its videos are left as written.
  if (imageBaseDir && !/^https?:\/\//i.test(imageBaseDir) && usesDefaultImageSrcResolver()) {
    root.querySelectorAll('video[src], video source[src]').forEach((media) => {
      const src = media.getAttribute('src');
      if (!src || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(src)) return;
      // `clip.mp4#t=5` keeps its media fragment on the new URL; a query is dropped.
      const hash = src.indexOf('#');
      const fragment = hash >= 0 ? src.slice(hash) : '';
      const file = src.slice(0, hash >= 0 ? hash : undefined).split('?')[0]!;
      if (!file) return;
      media.setAttribute('src', `/api/annotate-media?path=${encodeURIComponent(file)}&base=${encodeURIComponent(imageBaseDir)}${fragment}`);
    });
  }
  root.querySelectorAll('video[poster]').forEach((video) => {
    const poster = video.getAttribute('poster');
    if (!poster || /^(https?:|data:|blob:)/i.test(poster)) return;
    video.setAttribute('poster', getImageSrc(poster, imageBaseDir));
  });
}

// Walks the inserted DOM and wires relative <a href> so they behave the same
// as their markdown counterparts (local media URLs: rewriteLocalMediaUrls):
// - Relative .md / .mdx / .txt / .html links open in the linked-doc overlay when
//   onOpenLinkedDoc is provided (same as [[wiki-links]] and [label](./x.md)).
// Absolute http(s) URLs and mailto: are left untouched.
function rewriteRelativeRefs(
  root: HTMLElement,
  onOpenLinkedDoc?: (path: string) => void,
  onOpenCodeFile?: (path: string) => void,
  onNavigateAnchor?: (hash: string) => void,
  resolveLocalLink?: LocalLinkResolver | null,
  resolveImage?: ImageResolver | null,
  matchLocalLink: (href: string) => boolean = isLocalLinkTarget,
): (() => void) {
  const cleanups: (() => void)[] = [];

  if (resolveImage) {
    // Media was already decided by the host before insertion (see
    // resolveHostMedia); only the load-failure fallback is wired here.
    root.querySelectorAll<HTMLImageElement>('img[data-host-image]').forEach((img) => {
      // The raw HTML is not React's: replacing the <img> here cannot trip React's insertBefore.
      // The placeholder's alt text is never quoted by a text comment (annotation-exclude).
      const onError = () => {
        const placeholder = unavailableMedia(img.ownerDocument, img.getAttribute('alt') || 'Image', IMAGE_NOT_FOUND_TITLE);
        placeholder.classList.add('annotation-exclude');
        img.replaceWith(placeholder);
      };
      img.addEventListener('error', onError);
      cleanups.push(() => img.removeEventListener('error', onError));
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
    // A host's wider link test (`LocalLinkMatchContext`) may claim these too; by default they are left as written.
    if (/^(mailto:|tel:)/i.test(href) && !(resolveLocalLink && matchLocalLink(href))) return;
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
    const localLink = resolveLocalLink && matchLocalLink(href) ? resolveLocalLink(href) : null;
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
  const matchLocalLink = useLocalLinkMatch();
  /** The HTML this block last wrote, and where (the no-resolver path). */
  const written = useRef<{ element: HTMLDivElement; html: string; resolveLocalLink: LocalLinkResolver | null; matchLocalLink: (href: string) => boolean } | null>(null);
  const resolveImage = useImageResolver();
  const preserveVideos = useContext(PreserveResolvedVideosContext);
  const responsiveImages = useContext(ResolvedResponsiveImagesContext);
  const sanitized = React.useMemo(
    () => sanitizeBlockHtml(block.content),
    [block.content],
  );
  // Hidden only when the sanitizer emptied it by dropping such a tag (`<iframe>`, `<div><script>…</div>`); a
  // spacer (`<p>&nbsp;</p>`, `<br>`) or an empty `<div></div>` draws as it always did.
  // In a view of the source (the rendered diff) nothing is hidden: the block draws as it did before.
  const sourceLike = useContext(SourceLikeInlineContext);
  const drawsNothing = React.useMemo(
    () => !sourceLike && holdsDroppedHtmlTag(block.content) && sanitizedHtmlDrawsNothing(sanitized),
    [sourceLike, block.content, sanitized],
  );
  // Opened by a tag the sanitizer drops (`<iframe>`, `<script>`): before these
  // were HTML blocks the line printed as a paragraph of text, so the page has
  // one `<p>` fewer than when such a comment was saved (see
  // useAnnotationHighlighter's restore, which checks for this mark). Only
  // these are marked: a block that was HTML before (`<div>…</div>`) moved nothing.
  const opensDropped = React.useMemo(() => opensDroppedHtmlTag(block.content), [block.content]);
  useEffect(() => {
    if (!ref.current || drawsNothing) return;
    if (resolveImage) {
      // Decide every media URL on an inert template first (nothing loads
      // there), then insert the result.
      const template = ref.current.ownerDocument.createElement('template');
      template.innerHTML = sanitized;
      resolveHostMedia(template.content, ref.current.ownerDocument, resolveImage, preserveVideos, responsiveImages);
      const earlier = htmlBlockPlayersIn(ref.current);
      ref.current.replaceChildren(template.content);
      keepHtmlBlockPlayers(ref.current, earlier);
      written.current = null;
    } else {
      const template = ref.current.ownerDocument.createElement('template');
      template.innerHTML = sanitized;
      rewriteLocalMediaUrls(template.content, imageBaseDir);
      const html = template.innerHTML;
      // Unchanged output (a callback changed identity): keep the live DOM, so
      // an open <details> stays open and a video keeps playing. A new link
      // resolver rebuilds: the link wiring rewrites some hrefs in place.
      const last = written.current;
      if (last?.element !== ref.current || last.html !== html || last.resolveLocalLink !== resolveLocalLink || last.matchLocalLink !== matchLocalLink) {
        ref.current.innerHTML = html;
        written.current = { element: ref.current, html, resolveLocalLink, matchLocalLink };
      }
    }
    const cleanup = rewriteRelativeRefs(ref.current, onOpenLinkedDoc, onOpenCodeFile, onNavigateAnchor, resolveLocalLink, resolveImage, matchLocalLink);
    const stopColors = paintAuthorColors(ref.current);
    const stopPlayers = wireHtmlBlockPlayers(ref.current);
    return () => {
      cleanup();
      stopPlayers();
      stopColors();
    };
  }, [sanitized, drawsNothing, imageBaseDir, onOpenLinkedDoc, onOpenCodeFile, onNavigateAnchor, resolveLocalLink, resolveImage, matchLocalLink, preserveVideos, responsiveImages]);
  if (drawsNothing) {
    // Nothing the sanitizer kept is drawn (an embed, a script, a form with no
    // words): no gap in the page. The block keeps its id, so the document's
    // block order is the same.
    return <div hidden data-block-id={block.id} data-block-type="html" data-html-dropped={opensDropped ? "" : undefined} {...sourceLineAttrs(block)} />;
  }
  return (
    <div className="relative my-4" {...sourceLineAttrs(block)}>
      <div
        ref={ref}
        data-block-id={block.id}
        data-block-type="html"
        data-html-dropped={opensDropped ? "" : undefined}
        className="html-block text-[15px] leading-relaxed text-foreground/90"
      />
    </div>
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
