/**
 * Shape's offer when its picture's chunk cannot arrive (review of #2902, finding 1): a dropped link, or an Inbox
 * restarted onto a new release whose chunk names no longer exist. The window has no boundary of its own at the top,
 * so a lazy part that throws without one unmounts the whole Inbox, and a reply being typed goes with it.
 *
 * What regresses: the dialog's picture losing its `LazyBlockBoundary` (the Inbox unmounting, the typed words gone);
 * the dialog not showing its words and buttons over the empty band; its buttons not working.
 *
 * Its own file: the picture's chunk never arrives here (`shapeOfferArtChunk.load` rejects), and a part that once loaded
 * stays loaded for the page, so no other test may load it first.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ShapeOffer, preloadShapeOfferArt, shapeOfferArtChunk } = (hasDom ? await import('./components/ShapeOffer') : {}) as typeof import('./components/ShapeOffer');
/** Every fetch of the picture's chunk fails, as the browser's does for a chunk whose name the server no longer has. */
let fetches = 0;
if (hasDom) {
  shapeOfferArtChunk.load = () => {
    fetches++;
    return Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/ShapeOfferArt-gone.js'));
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedError: typeof console.error;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  if (savedError) console.error = savedError;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe.skipIf(!hasDom)("Shape's offer without its picture", () => {
  test('the chunk fails to load: the dialog still shows its words and buttons, and the window (a typed reply) stays', async () => {
    // React and the boundary report the failure on the console; that is expected here.
    savedError = console.error;
    console.error = () => {};
    // The preload failed earlier on this load (it says nothing); the dialog then asks for the chunk again.
    preloadShapeOfferArt();
    await wait(20);
    const closed: string[] = [];
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <>
          <main className="ib-main">
            <h1>Inbox</h1>
            <textarea data-reply="" defaultValue="half a reply" />
          </main>
          <ShapeOffer phone={false} onClose={() => closed.push('not now')} onTurnOn={() => closed.push('on')} />
        </>,
      );
    });
    await wait(60);
    // The dialog asked for the chunk again after the failed preload, and that failed too.
    expect(fetches).toBe(2);
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-dialog="shape-offer"]');
    expect(dialog).not.toBeNull();
    // The band is there and empty; the words and both buttons are drawn.
    expect(dialog!.querySelector('.ib-sho-art')).not.toBeNull();
    expect(dialog!.querySelector('[data-shape-offer-board]')).toBeNull();
    expect(dialog!.querySelector('h2')!.textContent!.trim()).not.toBe('');
    expect(dialog!.querySelectorAll('.ib-cro-feats li').length).toBe(3);
    // The rest of the window is still mounted, with what the person typed.
    expect(document.querySelector<HTMLTextAreaElement>('[data-reply]')?.value).toBe('half a reply');
    act(() => dialog!.querySelector<HTMLButtonElement>('[data-shape-offer-on]')!.click());
    act(() => dialog!.querySelector<HTMLButtonElement>('[data-shape-offer-close]')!.click());
    expect(closed).toEqual(['on', 'not now']);
  });
});
