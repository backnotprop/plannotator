// Marks rendered elements with attributes only (never moves a node): the text belongs to the renderer and highlighter.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { isGitHubAttachmentUrl } from '@plannotator/core/pr-attachment-url';
import { inboxApi } from '../api';
import { mayBeVideoLink, probeVideo, pullMediaSizes, reservedBox, servesPullMedia, writtenMediaUrl, type PullMediaItem, type PullMediaSizes } from './pullMedia';
import { PullMediaViewer } from './PullMediaViewer';

const CHIP_TITLE = 'Images in a description open on the forge';

export function forgeImageResolver(layer: InboxPull): ImageResolver {
  const serves = servesPullMedia(layer);
  return (src) => {
    if (src.startsWith('data:image/')) return { kind: 'src', src };
    if (serves && isGitHubAttachmentUrl(src)) return { kind: 'src', src: inboxApi.pullMediaUrl(layer.key, new URL(src).href) };
    return { kind: 'unavailable', title: CHIP_TITLE };
  };
}

const MEDIA = 'data-pull-media';

function shown(img: HTMLImageElement): boolean {
  return !img.hidden && !img.hasAttribute('data-image-failed');
}

export function ForgeMedia({ layer, children }: { layer: InboxPull; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<PullMediaItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const serves = servesPullMedia(layer);
  const key = layer.key;

  useEffect(() => {
    const root = ref.current;
    if (!root || !serves) return;
    let live = true;
    let sizes: PullMediaSizes = {};
    const decorate = () => {
      for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
        const url = writtenMediaUrl(img.getAttribute('src') ?? '');
        const size = url ? sizes[url] : undefined;
        if (size && !img.hasAttribute('height')) {
          const box = reservedBox(size, Number(img.getAttribute('width')) || null);
          img.setAttribute('width', String(box.width));
          img.setAttribute('height', String(box.height));
        }
        if (url === null || !shown(img)) {
          if (img.hasAttribute(MEDIA)) for (const name of [MEDIA, 'role', 'tabindex', 'aria-label']) img.removeAttribute(name);
          continue;
        }
        img.setAttribute(MEDIA, 'image');
        img.setAttribute('role', 'button');
        img.setAttribute('tabindex', '0');
        img.setAttribute('aria-label', `Open ${img.alt || 'picture'} in the viewer`);
      }
      for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        if (link.hasAttribute(MEDIA) || link.querySelector('img') || !mayBeVideoLink(href)) continue;
        void probeVideo(key, href).then((video) => {
          if (!live || !video || !link.isConnected) return;
          link.setAttribute(MEDIA, 'video');
          link.setAttribute('title', 'Play in the viewer');
        });
      }
    };
    decorate();
    void pullMediaSizes(key).then((read) => {
      if (!live) return;
      sizes = read;
      decorate();
    });
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(decorate);
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'hidden', 'data-image-failed'] });
    return () => {
      live = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [key, serves]);

  const itemOf = (element: HTMLElement): PullMediaItem | null => {
    if (element.getAttribute(MEDIA) === 'video') {
      const url = element.getAttribute('href') ?? '';
      const words = (element.textContent ?? '').trim();
      return { url, kind: 'video', name: words && words !== url ? words : 'Video' };
    }
    const url = writtenMediaUrl(element.getAttribute('src') ?? '');
    return url ? { url, kind: 'image', name: (element as HTMLImageElement).alt || 'Picture' } : null;
  };

  const target = (event: React.SyntheticEvent): HTMLElement | null => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(`[${MEDIA}]`) : null;
    return element && ref.current?.contains(element) ? element : null;
  };

  const show = (element: HTMLElement) => {
    const item = itemOf(element);
    if (!item) return;
    opener.current = element;
    setOpen(item);
  };

  return (
    <div
      ref={ref}
      onClickCapture={(event) => {
        const element = target(event);
        if (!element) return;
        if (element.tagName === 'A' && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        event.preventDefault();
        event.stopPropagation();
        show(element);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const element = target(event);
        if (!element || element.tagName === 'A' || element !== event.target) return;
        event.preventDefault();
        event.stopPropagation();
        show(element);
      }}
    >
      {children}
      {open && (
        <PullMediaViewer
          pullKey={key}
          item={open}
          onClose={() => {
            setOpen(null);
            opener.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
