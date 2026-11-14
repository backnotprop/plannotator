/**
 * The focus when a Show me's new board opens (boardFocus.ts). What regresses if these fail: the new board's title
 * loses the focus to the page as the board draws again while it settles (a keyboard or a screen reader is left on
 * nothing), or the title takes the focus back from where the person moved it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { focusBoardTitle } from './boardFocus';

const hasDom = typeof document !== 'undefined';
const frames = (n = 3) => new Promise<void>((resolve) => {
  const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});
const layer = (id: string, title: string) => {
  const section = document.createElement('section');
  section.setAttribute('data-shape-layer', id);
  section.innerHTML = `<h1>${title}</h1><button>Close</button>`;
  document.body.appendChild(section);
  return section;
};
afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

test.skipIf(!hasDom)('the new board drawn again as it settles: the focus goes back to its title, and the title is said once', async () => {
  const said: string[] = [];
  focusBoardTitle('b2', (title) => said.push(title));
  await frames(1);
  const section = layer('b2', 'About the lock');
  await frames();
  expect(document.activeElement?.textContent).toBe('About the lock');
  // The board draws its title again: the old one leaves with the focus.
  section.innerHTML = '<h1>About the lock</h1><button>Close</button>';
  expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  await frames();
  expect(document.activeElement).toBe(section.querySelector('h1'));
  expect(said).toEqual(['About the lock']);
});

test.skipIf(!hasDom)('a focus the person moved stays where they put it', async () => {
  focusBoardTitle('b3', () => {});
  await frames(1);
  const section = layer('b3', 'About the queue');
  await frames();
  const close = section.querySelector('button')!;
  close.focus();
  section.querySelector('h1')!.remove();
  section.insertAdjacentHTML('afterbegin', '<h1>About the queue</h1>');
  await frames();
  expect(document.activeElement).toBe(close);
});
