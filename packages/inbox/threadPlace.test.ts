/**
 * What holds the thread's place when a file opens from a tile (threadPlace.ts `placeOfOpener`). A tile in a message's
 * header band sits under the sender row, and the thread has no heading in its body any more: held by the tile, the
 * narrower column beside the file pushed the row (two lines there) above the view (CI run 43852392859,
 * inbox-attachments.spec.ts "the header says the message has files": "cut by .ib-pbody").
 *
 * What regresses: a header-band tile holding the place itself while its sender row is in view; the row holding it when
 * the row is scrolled away, or for a tile that is not in the header band.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { placeOfOpener } from './threadPlace';

const hasDom = typeof document !== 'undefined';

/** happy-dom has no layout: the box `el` is drawn in, top to bottom. */
function at(el: HTMLElement, top: number, bottom: number) {
  const rect = { top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top } as DOMRect;
  el.getBoundingClientRect = () => rect;
  el.getClientRects = () => [rect] as unknown as DOMRectList;
}

let root: HTMLElement | null = null;
afterEach(() => {
  root?.remove();
  root = null;
});

/** A thread's view (0 to 800) with one message: its sender row at `headTop`, a header-band tile and a tile at its foot. */
function thread(headTop: number) {
  root?.remove();
  root = document.createElement('div');
  root.innerHTML = `
    <div data-message-article="m1">
      <div class="ib-fline" data-open-head=""></div>
      <div class="ib-attachments ib-hatts-tiles"><div data-attachment-id="a1"><button>Open</button></div></div>
      <div class="ib-attachments"><div data-attachment-id="a1"><button>Open</button></div></div>
    </div>`;
  document.body.appendChild(root);
  at(root, 0, 800);
  const head = root.querySelector<HTMLElement>('[data-open-head]')!;
  at(head, headTop, headTop + 24);
  const [band, foot] = [...root.querySelectorAll<HTMLElement>('[data-attachment-id]')];
  at(band!, headTop + 40, headTop + 90);
  at(foot!, 600, 650);
  return { body: root, head, band: band!, foot: foot! };
}

test.skipIf(!hasDom)("a header-band tile: its message's sender row holds the place while it is in view", () => {
  const t = thread(18);
  expect(placeOfOpener(t.band, t.body)).toBe(t.head);
});

test.skipIf(!hasDom)('the sender row scrolled away, or a tile at the foot: the tile holds it', () => {
  const t = thread(-10);
  expect(placeOfOpener(t.band, t.body)).toBe(t.band);
  const u = thread(18);
  expect(placeOfOpener(u.foot, u.body)).toBe(u.foot);
});
