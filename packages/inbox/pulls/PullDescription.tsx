/** A PR body is someone else's words. Remote images do not load (CSP `img-src 'self' data: blob:`): a picture is its alt text in a chip. Folded, only its start is parsed. */

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { ContextMarkdown } from '../components/ContextMarkdown';
import { forgeBody, forgeFileUrl, isLiveLink } from './descriptionLinks';

const resolveImage: ImageResolver = (src) => (src.startsWith('data:image/') ? { kind: 'src', src } : { kind: 'unavailable', title: 'Images in a description open on the forge' });

const FOLDED_CHARS = 4000;

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
        <ContextMarkdown markdown={forgeBody(markdown)} className="ib-body" refRepo={{ display: layer.repo, host: layer.host }} resolveLocalLink={resolveLink} />
      </ImageResolverContext.Provider>
    </div>
  );
}

export function PullDescription({ markdown, layer, headSha }: { markdown: string | null | undefined; layer: InboxPull; headSha?: string | null }) {
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
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
