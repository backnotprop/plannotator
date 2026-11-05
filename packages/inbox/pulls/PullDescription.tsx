/**
 * A PR's own description at the head of its diff, in the Inbox's read-only Markdown. A long one starts folded and opens
 * into a box of its own height, so the diff is never far. No description draws nothing.
 *
 * A body is someone else's words. Its images do not load: the window's CSP is `img-src 'self' data: blob:`, so a remote
 * picture is its alt text in ui's quiet chip (a diagram can still name one: the CSP stops it, so nothing leaves, and it
 * is a broken picture and a CSP report). A path opens on the forge, never as an address of this window, and only the
 * web's links stay links. Folded, only its start is parsed, so a hostile one costs its reader nothing until they open it.
 */

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { ContextMarkdown } from '../components/ContextMarkdown';
import { forgeFileUrl, isLiveLink } from './descriptionLinks';

const resolveImage: ImageResolver = (src) => (src.startsWith('data:image/') ? { kind: 'src', src } : { kind: 'unavailable', title: 'Images in a description open on the forge' });

/** How much of a body is parsed while folded: far past what the fold shows. */
const FOLDED_CHARS = 4000;

/** The start of a long body. A `<details>` the cut leaves open is closed, or its lines would draw outside its box. */
function foldedStart(markdown: string): string {
  const line = markdown.lastIndexOf('\n', FOLDED_CHARS);
  const start = markdown.slice(0, line > FOLDED_CHARS / 2 ? line : FOLDED_CHARS);
  const unclosed = (start.match(/<details(?:\s|>|\/|$)/gi)?.length ?? 0) - (start.match(/<\/details\s*>/gi)?.length ?? 0);
  if (unclosed <= 0) return start;
  // A log in a fence, cut mid-way: the fence ends first, or the closing tag would be one more line of it.
  const fences = start.match(/^ *`{3,}/gm) ?? [];
  const fence = fences.length % 2 ? `\n${fences[fences.length - 1]!.trim()}` : '';
  return `${start}${fence}\n${'</details>'.repeat(unclosed)}`;
}

/**
 * A link's click: what is not the web's stays in the page, an anchor or an empty address never moves the window (its
 * route is its hash), and the web's links never replace it. ui takes `//host/a.md` or `HTTPS://host/a.md` for a local
 * document by its extension and draws it with no target, so such a link opens its new tab here, as any other does.
 */
function keepInPage(event: MouseEvent) {
  const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute('href')?.trim();
  if (!isLiveLink(link) || !href || href.startsWith('#')) {
    event.preventDefault();
    return;
  }
  if (link.protocol !== 'mailto:' && link.target !== '_blank' && !link.hasAttribute('data-local-link')) {
    event.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  }
}

/** Words a stranger wrote on the forge, in the page: a picture is its words, a link never replaces the window. */
export function ForgeMarkdown({ markdown, layer, headSha }: { markdown: string; layer: InboxPull; headSha?: string | null }) {
  const resolveLink = useMemo<LocalLinkResolver>(() => {
    const forge = layer.platform === 'gitlab' ? 'GitLab' : 'GitHub';
    return (href) => {
      const url = forgeFileUrl(layer, headSha, href);
      if (!url) return { kind: 'unavailable', title: `Not a file on ${forge}` };
      return { kind: 'open', href: url, title: `Open on ${forge}`, open: () => window.open(url, '_blank', 'noopener,noreferrer') };
    };
  }, [layer, headSha]);
  return (
    <div onClickCapture={keepInPage} onAuxClickCapture={keepInPage}>
      <ImageResolverContext.Provider value={resolveImage}>
        <ContextMarkdown markdown={markdown} className="ib-body" refRepo={{ display: layer.repo, host: layer.host }} resolveLocalLink={resolveLink} />
      </ImageResolverContext.Provider>
    </div>
  );
}

export function PullDescription({ markdown, layer, headSha }: { markdown: string | null | undefined; layer: InboxPull; headSha?: string | null }) {
  const body = useRef<HTMLDivElement>(null);
  // Whether it is taller than its fold (--ib-desc-fold), measured while folded and on every change of width.
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  // They opened a <details> in it: it grew under their click, so it stays open rather than folding away.
  const summaryUsed = useRef(false);
  useLayoutEffect(() => {
    summaryUsed.current = false;
    const box = body.current;
    if (!box) return;
    const inner = box.firstElementChild;
    const read = () => {
      const over = (inner?.scrollHeight ?? 0) > parseFloat(getComputedStyle(box).getPropertyValue('--ib-desc-fold')) + 24;
      if (over && summaryUsed.current) setOpen(true);
      setTall(over);
    };
    read();
    if (typeof ResizeObserver === 'undefined' || !inner) return;
    const observer = new ResizeObserver(read);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [markdown]);
  const cut = (markdown?.length ?? 0) > FOLDED_CHARS;
  const long = tall || cut;
  const folded = long && !open;
  const shown = useMemo(() => (markdown && folded && cut ? foldedStart(markdown) : markdown), [markdown, folded, cut]);
  if (!markdown || !shown) return null;
  return (
    <section
      className="ib-prr-desc"
      aria-label="Description"
      data-pull-description={folded ? 'folded' : open && long ? 'open' : 'whole'}
      onClick={folded ? () => setOpen(true) : undefined}
      onClickCapture={(event) => {
        if ((event.target as Element).closest?.('summary')) summaryUsed.current = true;
      }}
    >
      {/* Folded, what is clipped takes no Tab stops; a click anywhere on it opens it. */}
      <div ref={body} className="ib-prr-desc-body" inert={folded}>
        <ForgeMarkdown markdown={shown} layer={layer} headSha={headSha} />
      </div>
      {long && (
        <button
          type="button"
          className="ib-prr-desc-more"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            // Show less is their word: a <details> they opened no longer holds it open.
            if (open) summaryUsed.current = false;
            setOpen(!open);
          }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}
