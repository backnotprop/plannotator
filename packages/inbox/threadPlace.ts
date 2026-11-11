/** Where the person is in a thread, kept while a file covers or narrows it. A scrollTop is not a place (messages reflow; WebKit drops a hidden box's scrollTop): a place is an element and its distance from the top of the view. */

export interface ThreadPlace {
  el: HTMLElement;
  selector: string | null;
  offset: number;
  scrollTop: number;
}

export interface PlaceLayout {
  thread: string;
  file: 'none' | 'side' | 'covered';
  grid: boolean;
  guide: boolean;
}

export const placeLayoutKey = (layout: PlaceLayout): string => [layout.thread, layout.file, layout.grid ? 'grid' : '', layout.guide ? 'guide' : ''].join('|');

export function parsePlaceLayout(key: string): PlaceLayout {
  const [thread = '', file = 'none', grid = '', guide = ''] = key.split('|');
  return { thread, file: file === 'side' || file === 'covered' ? file : 'none', grid: grid === 'grid', guide: guide === 'guide' };
}

export const placeShown = (layout: PlaceLayout): boolean => layout.file !== 'covered' && !layout.grid && !layout.guide;

const PLACE_CANDIDATES = [
  '.ib-subject',
  '[data-fold-head]',
  '[data-open-head]',
  '[data-message-article] :is(p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, img, [data-attachment-id])',
].join(', ');

const laidOut = (el: Element): boolean => el.getClientRects().length > 0;

export function placeSelector(el: HTMLElement): string | null {
  const message = el.closest<HTMLElement>('[data-message-article]')?.getAttribute('data-message-article');
  if (!message) return null;
  const scope = `[data-message-article="${CSS.escape(message)}"]`;
  const inline = el.getAttribute('data-inline-image');
  if (el instanceof HTMLImageElement && inline) return `${scope} img[data-inline-image="${CSS.escape(inline)}"]`;
  const attachment = el.getAttribute('data-attachment-id');
  if (attachment) {
    const band = el.closest('.ib-hatts-tiles') ? '.ib-hatts-tiles' : '.ib-attachments:not(.ib-hatts-tiles)';
    return `${scope} ${band} [data-attachment-id="${CSS.escape(attachment)}"]`;
  }
  if (el.hasAttribute('data-message-article')) return scope;
  return null;
}

export function openerOf(target: EventTarget | null, body: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-attachment-id], img[data-inline-image], a[href]');
  return el && body.contains(el) ? el : null;
}

export function opensFile(el: HTMLElement, fileId: string): boolean {
  if (el.getAttribute('data-attachment-id') === fileId || el.getAttribute('data-inline-image') === fileId) return true;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
  const hash = href?.startsWith('#') ? href.slice(1) : null;
  return hash !== null && new URLSearchParams(hash).get('file') === fileId;
}

export function capturePlace(body: HTMLElement, preferred: HTMLElement | null): ThreadPlace | null {
  if (body.clientHeight === 0 || !laidOut(body)) return null;
  const view = body.getBoundingClientRect();
  const inView = (r: DOMRect) => r.bottom > view.top + 1 && r.top < view.bottom - 1;
  let el: HTMLElement | null = null;
  if (preferred && preferred.isConnected && body.contains(preferred) && laidOut(preferred) && inView(preferred.getBoundingClientRect())) el = preferred;
  if (!el) {
    let straddling: HTMLElement | null = null;
    for (const candidate of body.querySelectorAll<HTMLElement>(PLACE_CANDIDATES)) {
      const r = candidate.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      if (r.top >= view.top - 0.5 && r.top < view.bottom) {
        el = candidate;
        break;
      }
      if (!straddling && inView(r)) straddling = candidate;
    }
    el ??= straddling;
  }
  if (!el) return { el: body, selector: null, offset: 0, scrollTop: body.scrollTop };
  return { el, selector: placeSelector(el), offset: el.getBoundingClientRect().top - view.top, scrollTop: body.scrollTop };
}

export function placeInView(body: HTMLElement, place: ThreadPlace): boolean {
  if (place.el === body || !place.el.isConnected || !body.contains(place.el) || !laidOut(place.el)) return false;
  const view = body.getBoundingClientRect();
  const r = place.el.getBoundingClientRect();
  return r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
}

export function restorePlace(body: HTMLElement, place: ThreadPlace): boolean {
  if (body.clientHeight === 0 || !laidOut(body)) return false;
  let el: HTMLElement | null = place.el !== body && place.el.isConnected && body.contains(place.el) ? place.el : null;
  if (!el && place.selector) el = body.querySelector<HTMLElement>(place.selector);
  if (el && laidOut(el)) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - place.offset;
  else body.scrollTop = place.scrollTop;
  return true;
}

export const PLACE_HOLD_MS = 1200;

export function holdPlace(body: HTMLElement, place: ThreadPlace, onPlaced?: () => void, holdMs = PLACE_HOLD_MS, inputRoot: HTMLElement = body): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heldAt = body.scrollTop;
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  // Scroll anchoring would move the view itself as the layout settles, and that scroll cannot be told from the person's: off while the hold puts the place back.
  const anchoring = body.style.overflowAnchor;
  body.style.overflowAnchor = 'none';
  const onScroll = () => {
    if (Math.abs(body.scrollTop - heldAt) > 1) stop();
  };
  const observer = new ResizeObserver(() => {
    if (restorePlace(body, place)) {
      heldAt = body.scrollTop;
      onPlaced?.();
    }
    arm();
  });
  function stop() {
    observer.disconnect();
    body.style.overflowAnchor = anchoring;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const type of inputs) inputRoot.removeEventListener(type, stop, true);
    body.removeEventListener('scroll', onScroll);
  }
  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(stop, holdMs);
  }
  observer.observe(body);
  for (const child of body.children) observer.observe(child);
  for (const type of inputs) inputRoot.addEventListener(type, stop, { capture: true, passive: true });
  body.addEventListener('scroll', onScroll, { passive: true });
  arm();
  return stop;
}
