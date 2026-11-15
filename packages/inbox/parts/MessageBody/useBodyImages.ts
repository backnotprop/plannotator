/** MessageBody's pictures (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { InboxInlineImage } from '@plannotator/core/inbox-types';
import type { HtmlEmbedHost } from '@plannotator/ui/components/html-embed/HtmlEmbedBlock';
import { agentName } from '../../format';
import { inboxMessageImageBase, inlineImageRefFromSrc, syncMessageImages, toggleMessageImage, MESSAGE_IMAGE_WIDTH, drawnImageUrl } from '../../images';
import type { RefObject } from 'react';
import type { MessageBodyProps } from './types';
import { inboxEmbedUrl } from '../../data/actions/embed';

/** The body's pictures: where they load from, their boxes, and what opens one (the viewer, or the lightbox). */
export function useBodyImages({
  message,
  imageBase,
  bodyRef,
  onOpenInlineImage,
  inlineRefOf,
  onImage,
  onOpenOptionSet,
}: Pick<MessageBodyProps, 'message' | 'imageBase' | 'onOpenInlineImage' | 'inlineRefOf' | 'onImage' | 'onOpenOptionSet'> & { bodyRef: RefObject<HTMLDivElement | null> }) {
  // The body's images go through a host resolver that names the same URL ui's
  // default would (the window's resolver, `inboxImageSrcResolver`), only so ui
  // draws an image the Inbox refuses (403 image_hidden, 404) as its alt text in
  // a quiet chip instead of a broken-image icon: markdown images, `<img>` in
  // raw-HTML blocks and question cards' pictures alike. Remote, `data:` and
  // `blob:` sources keep their URL (HtmlBlock's default test: `https:host/a.png`
  // is remote too).
  const imageBaseDir = imageBase ?? inboxMessageImageBase(message.id);
  // ```html fences draw as live, sandboxed pages, ```svg as images (approval "inbox-inline-html").
  const embedAuthor = message.author.kind === 'agent' ? agentName(message.author) : undefined;
  const htmlEmbeds = useMemo<HtmlEmbedHost>(() => ({ frameUrl: inboxEmbedUrl, author: embedAuthor }), [embedAuthor]);
  // A captured picture wider than a message draws it is loaded as a smaller copy (`?w=`), laid out at its own
  // width: the browser decodes the copy, not a 3840-wide screenshot (a heavy thread's tab died of them). A click
  // still opens the original in the viewer.
  const widthsKey = (message.inline_images ?? []).map((image) => `${image.width ?? ''}:${image.ref}`).join('\n');
  const widths = useMemo(() => new Map((message.inline_images ?? []).map((image) => [image.ref, image.width] as const)), [widthsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolveImage = useCallback<ImageResolver>(
    (src) => {
      if (/^(https?:|data:|blob:)/i.test(src)) return { kind: 'src', src };
      const url = getImageSrc(src, imageBaseDir);
      const width = widths.get(src);
      const drawn = drawnImageUrl(url, width, MESSAGE_IMAGE_WIDTH);
      return drawn === url ? { kind: 'src', src: url } : { kind: 'src', src: drawn, width };
    },
    [imageBaseDir, widths],
  );
  // Images the body shows open in the thread's one viewer (approval "inbox-image-viewer"): a
  // click, or Enter / Space on one (every image the window loads from the message is a button).
  // Until the store has captured it (a later read of the thread does, in the background), the
  // plain lightbox shows it, so a click always opens something.
  const inlineRef = useRef<readonly InboxInlineImage[]>(message.inline_images ?? []);
  inlineRef.current = message.inline_images ?? [];
  const openImageRef = useRef(onOpenInlineImage);
  openImageRef.current = onOpenInlineImage;
  const [fallback, setFallback] = useState<{ src: string; alt: string } | null>(null);
  const refOfRef = useRef(inlineRefOf);
  refOfRef.current = inlineRefOf;
  const refOf = useCallback((src: string) => (refOfRef.current ? refOfRef.current(src) : inlineImageRefFromSrc(src, message.id)), [message.id]);
  const imageOf = useCallback(
    (src: string | null) => {
      const ref = src ? refOf(src) : null;
      return ref === null ? null : (inlineRef.current.find((image) => image.ref === ref) ?? null);
    },
    [refOf],
  );
  /** Open one of the body's images: its captured file in the viewer, else the lightbox. False: not one of them. */
  const openImage = useCallback(
    (src: string | null, alt: string): boolean => {
      if (!src || refOf(src) === null) return false;
      // An image that failed to load (outside the project, gone) opens nothing: an empty lightbox helps no one.
      if ([...(bodyRef.current?.querySelectorAll<HTMLImageElement>('img[data-ib-broken]') ?? [])].some((img) => img.getAttribute('src') === src)) return true;
      const image = imageOf(src);
      if (image && openImageRef.current) openImageRef.current(image);
      else setFallback({ src, alt });
      return true;
    },
    [imageOf, refOf],
  );
  /** A picture choice's size, recorded when the message was sent, so its card is laid out before the picture loads. */
  const pictureSizeOf = useCallback((src: string) => {
    const image = imageOf(src);
    return image?.width && image.height ? { width: image.width, height: image.height } : null;
    // A new identity when the records change (an older message's pictures are captured on its first open).
  }, [imageOf, message.inline_images]);
  // Each picture's box, from its recorded size before it loads (no jump as the thread fills in), and the
  // "Show all" of a very long one. Before paint on every render; again when a picture loads, the body's
  // column changes width or the window changes height.
  const openPictures = useRef(new Set<string>());
  const fitImages = useCallback(() => {
    const body = bodyRef.current;
    if (body) syncMessageImages(body, (img) => imageOf(img.getAttribute('src')), openPictures.current);
  }, [imageOf]);
  useLayoutEffect(fitImages);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) fitImages();
    };
    // Load does not bubble: a capture listener on the body hears every image in it.
    body.addEventListener('load', onLoad, true);
    const onMore = (event: MouseEvent) => {
      const img = toggleMessageImage(event.target, openPictures.current);
      if (!img) return;
      event.preventDefault();
      event.stopPropagation();
      const closing = img.hasAttribute('data-ib-open');
      fitImages();
      // Closed from the bottom of a long picture: its top comes back into view rather than the thread jumping past it.
      if (closing) img.scrollIntoView?.({ block: 'nearest' });
    };
    body.addEventListener('click', onMore);
    window.addEventListener('resize', fitImages);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitImages);
    observer?.observe(body);
    return () => {
      body.removeEventListener('load', onLoad, true);
      body.removeEventListener('click', onMore);
      window.removeEventListener('resize', fitImages);
      observer?.disconnect();
    };
  }, [fitImages]);
  const onImageRef = useRef(onImage);
  onImageRef.current = onImage;
  const onImageClick = useCallback((src: string, alt: string) => (onImageRef.current ? onImageRef.current(src, alt) : void openImage(src, alt)), [openImage]);
  const openSetRef = useRef(onOpenOptionSet);
  openSetRef.current = onOpenOptionSet;
  /** A picture choice's zoom: its question's choices in the viewer, on this choice; a picture not captured yet (or a host's own `onImage`) opens as before. */
  const onZoomChoice = useCallback(
    (key: string, index: number, src: string, alt: string) => {
      const image = onImageRef.current ? null : imageOf(src);
      if (image && openSetRef.current) openSetRef.current(key, image, index);
      else onImageClick(src, alt);
    },
    [imageOf, onImageClick],
  );
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (const img of body.querySelectorAll<HTMLImageElement>('img')) {
      // A question card's picture (a picture choice, `Shows:`): the card makes it pick, or opens it with its own button.
      if (img.hasAttribute('data-question-picture')) continue;
      const src = img.getAttribute('src');
      const ref = src ? refOf(src) : null;
      if (ref === null || img.hasAttribute('data-ib-broken')) continue;
      const image = imageOf(src);
      const name = image?.name ?? ref.split(/[\\/]/).pop() ?? 'image';
      img.setAttribute('role', 'button');
      img.tabIndex = 0;
      img.setAttribute('aria-label', `Open ${name}${img.alt ? `, ${img.alt}` : ''}`);
      if (image) img.setAttribute('data-inline-image', image.id);
      else img.removeAttribute('data-inline-image');
      img.style.cursor = 'zoom-in';
    }
  });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // Markdown images reach openImage through Viewer's onImageClick; an image in a raw-HTML block has no handler of its own.
    const onClick = (event: MouseEvent) => {
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (!img || img.classList.contains('cursor-zoom-in') || img.hasAttribute('data-question-picture')) return;
      if (openImage(img.getAttribute('src'), img.alt)) event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (img && !img.hasAttribute('data-question-picture') && openImage(img.getAttribute('src'), img.alt)) event.preventDefault();
    };
    body.addEventListener('click', onClick);
    body.addEventListener('keydown', onKey);
    // An image that fails to load is not a button (error does not bubble: a capture listener hears it).
    const onError = (event: Event) => {
      const img = event.target instanceof HTMLImageElement ? event.target : null;
      if (!img) return;
      img.setAttribute('data-ib-broken', '');
      img.removeAttribute('role');
      img.removeAttribute('tabindex');
      img.removeAttribute('aria-label');
      img.style.cursor = '';
    };
    body.addEventListener('error', onError, true);
    return () => {
      body.removeEventListener('click', onClick);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('error', onError, true);
    };
  }, [openImage]);
  return { imageBaseDir, htmlEmbeds, resolveImage, fallback, setFallback, onImageClick, onZoomChoice, pictureSizeOf };
}
