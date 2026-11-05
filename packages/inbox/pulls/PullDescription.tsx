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

function foldedStart(markdown: string): string {
  const line = markdown.lastIndexOf('\n', FOLDED_CHARS);
  return markdown.slice(0, line > FOLDED_CHARS / 2 ? line : FOLDED_CHARS);
}

/** A link's click: what is not the web's stays in the page, and an anchor never moves the window's route (its hash). */
function keepInPage(event: MouseEvent) {
  const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
  if (link && (!isLiveLink(link) || link.getAttribute('href')?.startsWith('#'))) event.preventDefault();
}

export function PullDescription({ markdown, layer, headSha }: { markdown: string | null | undefined; layer: InboxPull; headSha?: string | null }) {
  const body = useRef<HTMLDivElement>(null);
  // Whether it is taller than its fold (--ib-desc-fold), measured while folded and on every change of width.
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  // They opened a <details> in it: it grew under their click, so it stays open rather than folding away.
  const summaryUsed = useRef(false);
  useLayoutEffect(() => {
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
  const resolveLink = useMemo<LocalLinkResolver>(() => {
    const forge = layer.platform === 'gitlab' ? 'GitLab' : 'GitHub';
    return (href) => {
      const url = forgeFileUrl(layer, headSha, href);
      if (!url) return { kind: 'unavailable', title: `Not a file on ${forge}` };
      return { kind: 'open', href: url, title: `Open on ${forge}`, open: () => window.open(url, '_blank', 'noopener,noreferrer') };
    };
  }, [layer, headSha]);
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
        keepInPage(event);
        if ((event.target as Element).closest?.('summary')) summaryUsed.current = true;
      }}
      onAuxClickCapture={keepInPage}
    >
      {/* Folded, what is clipped takes no Tab stops; a click anywhere on it opens it. */}
      <div ref={body} className="ib-prr-desc-body" inert={folded}>
        <ImageResolverContext.Provider value={resolveImage}>
          <ContextMarkdown markdown={shown} className="ib-body" refRepo={{ display: layer.repo, host: layer.host }} resolveLocalLink={resolveLink} />
        </ImageResolverContext.Provider>
      </div>
      {long && (
        <button
          type="button"
          className="ib-prr-desc-more"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}
