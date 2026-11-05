/**
 * A PR's own description at the head of its diff, in the Inbox's read-only Markdown. A long one starts folded and opens
 * into a box of its own height, so the diff is never far. No description draws nothing.
 *
 * Its images do not load: the window's CSP is `img-src 'self' data: blob:`, and a body is someone else's words, so a
 * remote picture is its alt text in ui's quiet chip, with no request made and no CSP report.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { ContextMarkdown } from '../components/ContextMarkdown';

const resolveImage: ImageResolver = (src) => (src.startsWith('data:image/') ? { kind: 'src', src } : { kind: 'unavailable', title: 'Images in a description open on the forge' });

export function PullDescription({ markdown, repo, host }: { markdown: string | null | undefined; repo: string; host: string }) {
  const body = useRef<HTMLDivElement>(null);
  // Whether it is taller than its fold (--ib-desc-fold), measured while folded and on every change of width.
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const box = body.current;
    if (!box) return;
    const inner = box.firstElementChild;
    const read = () => setLong((inner?.scrollHeight ?? 0) > parseFloat(getComputedStyle(box).getPropertyValue('--ib-desc-fold')) + 24);
    read();
    if (typeof ResizeObserver === 'undefined' || !inner) return;
    const observer = new ResizeObserver(read);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [markdown]);
  if (!markdown) return null;
  const folded = long && !open;
  return (
    <section className="ib-prr-desc" aria-label="Description" data-pull-description={folded ? 'folded' : open ? 'open' : 'whole'} onClick={folded ? () => setOpen(true) : undefined}>
      {/* Folded, what is clipped takes no Tab stops; a click anywhere on it opens it. */}
      <div ref={body} className="ib-prr-desc-body" inert={folded}>
        <ImageResolverContext.Provider value={resolveImage}>
          <ContextMarkdown markdown={markdown} className="ib-body" refRepo={{ display: repo, host }} />
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
