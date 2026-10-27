/**
 * Where the person is in a thread, kept while a file covers or narrows it
 * (the owner's report: closing a file put them back at the top of the thread).
 *
 * The thread's view changes shape around a file: beside it the thread is a
 * 440 px column (its messages reflow and grow taller), full screen it sits
 * under the file, and on a phone or a stacked window it is `display: none`
 * (WebKit drops a hidden box's scrollTop). A scrollTop number is therefore not
 * a place. A place is an element the person was looking at and how far it sat
 * from the top of the view: the tile or image they opened when it is on
 * screen, else the first thing that starts inside the view. Captured while the
 * old layout is still on screen, put back once the new one is laid out.
 */

export interface ThreadPlace {
  el: HTMLElement;
  /** Finds the element again if a render replaced it. */
  selector: string | null;
  /** Its top, from the top of the thread's view. */
  offset: number;
  /** The view's scrollTop, used when the element is gone. */
  scrollTop: number;
}

/** Which layout the thread is in; the place is read and put back each time it changes. */
export interface PlaceLayout {
  thread: string;
  /** No file open, a file beside the thread, or a file over it (full screen, a phone, a stacked window). */
  file: 'none' | 'side' | 'covered';
  /** The Artifacts grid stands in for the messages. */
  grid: boolean;
  /** A guided review is over the thread. */
  guide: boolean;
}

/** The layout as a string, for a hook's dependencies. */
export const placeLayoutKey = (layout: PlaceLayout): string => [layout.thread, layout.file, layout.grid ? 'grid' : '', layout.guide ? 'guide' : ''].join('|');

export function parsePlaceLayout(key: string): PlaceLayout {
  const [thread = '', file = 'none', grid = '', guide = ''] = key.split('|');
  return { thread, file: file === 'side' || file === 'covered' ? file : 'none', grid: grid === 'grid', guide: guide === 'guide' };
}

/** The messages are on screen (not under a file, the Artifacts grid or a guide). */
export const placeShown = (layout: PlaceLayout): boolean => layout.file !== 'covered' && !layout.grid && !layout.guide;

/** What may hold a place: message parts in reading order (a message's own box is a last resort, it is long). */
const PLACE_CANDIDATES = [
  '.ib-subject',
  '[data-fold-head]',
  '[data-open-head]',
  '[data-message-article] :is(p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, img, [data-attachment-id])',
].join(', ');

const laidOut = (el: Element): boolean => el.getClientRects().length > 0;

/** A selector that finds a tile, an image in a message's text or a message again after a render. */
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

/** The tile, image in the text or link a click or key in the thread was aimed at, if it could open a file. */
export function openerOf(target: EventTarget | null, body: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-attachment-id], img[data-inline-image], a[href]');
  return el && body.contains(el) ? el : null;
}

/** Whether `el` opens the file `fileId`: its tile, its image in a message's text, or a link to it (`file=` in the deep link). */
export function opensFile(el: HTMLElement, fileId: string): boolean {
  if (el.getAttribute('data-attachment-id') === fileId || el.getAttribute('data-inline-image') === fileId) return true;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
  const hash = href?.startsWith('#') ? href.slice(1) : null;
  return hash !== null && new URLSearchParams(hash).get('file') === fileId;
}

/** The place on screen now, or null when the thread is not laid out (hidden, covered by the Artifacts grid). */
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

/** Whether the place's element is still wholly inside the view (after a change of layout). */
export function placeInView(body: HTMLElement, place: ThreadPlace): boolean {
  if (place.el === body || !place.el.isConnected || !body.contains(place.el) || !laidOut(place.el)) return false;
  const view = body.getBoundingClientRect();
  const r = place.el.getBoundingClientRect();
  return r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
}

/** Put the place back: its element at the same distance from the top of the view. False when the thread is not laid out. */
export function restorePlace(body: HTMLElement, place: ThreadPlace): boolean {
  if (body.clientHeight === 0 || !laidOut(body)) return false;
  let el: HTMLElement | null = place.el !== body && place.el.isConnected && body.contains(place.el) ? place.el : null;
  if (!el && place.selector) el = body.querySelector<HTMLElement>(place.selector);
  if (el && laidOut(el)) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - place.offset;
  else body.scrollTop = place.scrollTop;
  return true;
}

/** How long a place is held after the last change of the thread's size (the sidebar's spring, a thumbnail loading). */
export const PLACE_HOLD_MS = 1200;

/**
 * Keep the place while the layout settles: the docked sidebar and the list
 * come back with a spring, thumbnails and fonts load, and each of those
 * reflows the messages under the view. Every resize of the view or of its
 * content puts the place back, until nothing has moved for PLACE_HOLD_MS, or
 * anything else scrolls the thread: the person (a wheel, a touch, a key or a
 * press anywhere in `inputRoot`, the thread's whole pane: its foot and header
 * act on the thread too, and any scroll that leaves the view somewhere the hold
 * did not put it: PageDown with focus on the page, an overlay scrollbar
 * dragged) or the app (a search result landing, a jump to a card, `n`, an
 * arrival followed; those also stop it before they scroll). Returns a
 * function that stops it. `onPlaced` hears each time it puts the place back.
 */
export function holdPlace(body: HTMLElement, place: ThreadPlace, onPlaced?: () => void, holdMs = PLACE_HOLD_MS, inputRoot: HTMLElement = body): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The scrollTop the hold last left the view at; a scroll that finds the view elsewhere is not the hold's. */
  let heldAt = body.scrollTop;
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  // The browser's scroll anchoring would move the view itself as the layout settles (a window stacking or
  // unstacking after this effect), and that scroll cannot be told from the person's: off while the hold puts
  // the place back instead.
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
