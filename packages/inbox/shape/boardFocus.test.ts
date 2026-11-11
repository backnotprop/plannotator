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
