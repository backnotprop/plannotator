/**
 * A thread on its line in the PR page. What regresses: a resolved or bots-only thread folded without saying why, or a
 * human thread folded at all; a long thread cut with no way to the rest; a comment the forge hides shown open; a
 * thread with no link to the forge (the page never replies or resolves); a thread the person opened folding again when
 * the diff draws its line again; an outdated thread's place unsaid; a thread on a whole file not in its band, not
 * folded to one line that names it, or not opening in place.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullDetailComment, InboxPullThread } from '@plannotator/core/inbox-types';
import type { PlacedThread } from './threadPlaces';

const hasDom = typeof document !== 'undefined';
const { FileThread, fileThreadOpen, LineThread, ThreadMemory } = (hasDom ? await import('./LineThreads') : {}) as typeof import('./LineThreads');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

const layer = {
  key: 'github.com/acme/web#7', platform: 'github', host: 'github.com', repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7',
  title: 'T', author: 'ana', mine: false, requested: true, state: 'open', base: 'main', head: 'b7', head_repo: 'acme/web', additions: 1, deletions: 0,
  files: 1, review: null, approved_by: null, reviewers: [], checks: 'success', updated_at: '2026-11-03T09:00:00.000Z', merged_at: null,
} as InboxPull;
const said = (id: string, fields: Partial<InboxPullDetailComment> = {}): InboxPullDetailComment => ({ id, author: 'theo', at: '2026-11-01T00:00:00Z', body: `words ${id}`, url: `https://github.com/acme/web/pull/7#discussion_${id}`, ...fields });
const thread = (fields: Partial<InboxPullThread> = {}): InboxPullThread => ({ id: 'T1', file: 'a.ts', line: 3, start_line: null, side: 'new', resolved: false, outdated: false, comments: [said('c1')], ...fields });
const at = (t: InboxPullThread, where: PlacedThread['where'] = 'line'): PlacedThread => ({ thread: t, line: t.line ?? 1, side: t.side, where });

function draw(placed: PlacedThread, memory = new ThreadMemory()) {
  act(() => root.render(<LineThread placed={placed} layer={layer} memory={memory} />));
  return memory;
}
const box = () => host.querySelector('[data-pull-thread]')!;
const comments = () => [...host.querySelectorAll('[data-pull-thread-comment]')].map((c) => c.getAttribute('data-pull-thread-comment'));

test.if(hasDom)("a person's open thread is open on its line, with every comment and a link to it on the forge", () => {
  draw(at(thread({ comments: [said('c1'), said('c2', { author: 'maya' })] })));
  expect(box().hasAttribute('data-open')).toBe(true);
  expect(comments()).toEqual(['c1', 'c2']);
  expect(host.textContent).toContain('words c1');
  expect(host.textContent).toContain('maya');
  const link = host.querySelector('a[aria-label="Open this thread on GitHub"]')!;
  expect(link.getAttribute('href')).toBe('https://github.com/acme/web/pull/7#discussion_c1');
  expect(link.getAttribute('target')).toBe('_blank');
  // Read-only: nothing to reply, resolve or edit with.
  expect(host.querySelector('textarea, input')).toBeNull();
});

test.if(hasDom)('resolved: one line that says so, who, the first words and how many; it opens in place and folds again', () => {
  draw(at(thread({ resolved: true, comments: [said('c1', { body: '## Why 202\nand not 200?' }), said('c2')] })));
  const row = box();
  expect(row.tagName).toBe('BUTTON');
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(row.getAttribute('data-pull-thread-folded')).toBe('resolved');
  const why = row.querySelector('[data-pull-thread-why]')!.textContent;
  expect(why).toBeTruthy();
  expect(row.textContent).toContain('theo');
  expect(row.textContent).toContain('Why 202');
  expect(row.querySelector('[aria-label="2 comments"]')!.textContent).toBe('2');
  act(() => (row as HTMLButtonElement).click());
  expect(comments()).toEqual(['c1', 'c2']);
  const refold = host.querySelector('[data-pull-thread-refold]') as HTMLButtonElement;
  expect(refold.textContent).toBe(why);
  act(() => refold.click());
  expect(box().tagName).toBe('BUTTON');
});

test.if(hasDom)('only bots speaking: one line, marked bot, that says why; a bot in a person\'s thread leaves it open', () => {
  draw(at(thread({ comments: [said('b1', { author: 'coderabbitai[bot]', bot: true })] })));
  expect(box().getAttribute('data-pull-thread-folded')).toBe('bot');
  expect(box().getAttribute('data-voice')).toBe('bot');
  expect(box().textContent).toContain('coderabbitai');
  const why = box().querySelector('[data-pull-thread-why]')?.textContent;
  expect(why).toBeTruthy();
  act(() => (box() as HTMLButtonElement).click());
  expect((host.querySelector('[data-pull-thread-refold]') as HTMLElement).textContent).toBe(why!);
  draw(at(thread({ id: 'T2', comments: [said('b1', { bot: true }), said('p1')] })));
  expect(box().hasAttribute('data-open')).toBe(true);
});

test.if(hasDom)('an outdated thread stays open and says a push moved its lines', () => {
  draw(at(thread({ outdated: true, line: null }), 'outdated'));
  expect(box().hasAttribute('data-open')).toBe(true);
  expect(box().getAttribute('data-pull-thread-where')).toBe('outdated');
  expect(box().querySelector('.ib-lt-top')!.textContent).toBeTruthy();
  // On its line, with nothing to say: no line above the comments.
  draw(at(thread({ id: 'T4' })));
  expect(box().querySelector('.ib-lt-top')).toBeNull();
});

test.if(hasDom)('a long thread: its first and last comment and "N more", which shows the rest', () => {
  draw(at(thread({ comments: Array.from({ length: 9 }, (_, i) => said(`c${i + 1}`)) })));
  expect(comments()).toEqual(['c1', 'c9']);
  const more = host.querySelector('[data-pull-thread-between]') as HTMLButtonElement;
  expect(more.getAttribute('data-pull-thread-between')).toBe('7');
  expect(more.textContent).toContain('7');
  act(() => more.click());
  expect(comments()).toHaveLength(9);
});

test.if(hasDom)('a comment the forge hides is one line with its reason, and shows on a click', () => {
  draw(at(thread({ comments: [said('c1'), said('c2', { hidden: 'off-topic', body: 'secret words' })] })));
  const hidden = host.querySelector('[data-pull-thread-hidden]') as HTMLButtonElement;
  expect(hidden.getAttribute('data-pull-thread-hidden')).toBe('off-topic');
  expect(host.textContent).not.toContain('secret words');
  act(() => hidden.click());
  expect(host.textContent).toContain('secret words');
});

test.if(hasDom)('what the person opened stays open when the diff draws the line again', () => {
  const memory = draw(at(thread({ resolved: true })));
  act(() => (box() as HTMLButtonElement).click());
  act(() => root.unmount());
  root = createRoot(host);
  draw(at(thread({ resolved: true })), memory);
  expect(box().hasAttribute('data-open')).toBe(true);
});

test.if(hasDom)("a thread on a whole file: folded, one line that says so, even unresolved; a click asks to open it, and open it shows the thread and folds again", () => {
  const memory = new ThreadMemory();
  const whole = thread({ id: 'W1', line: null, comments: [said('w1', { author: 'sam', body: 'Use CREATE INDEX CONCURRENTLY here.' }), said('w2', { author: 'theo' })] });
  const drawFile = (open: boolean) => act(() => root.render(<FileThread thread={whole} layer={layer} memory={memory} open={open} />));
  expect(fileThreadOpen(memory, 'W1')).toBe(false);
  drawFile(false);
  const band = box() as HTMLButtonElement;
  expect(band.tagName).toBe('BUTTON');
  expect(band.getAttribute('aria-expanded')).toBe('false');
  expect(band.getAttribute('data-pull-thread-where')).toBe('file');
  expect(band.textContent).toContain('On this file');
  expect(band.textContent).toContain('sam');
  expect(band.textContent).toContain('Use CREATE INDEX CONCURRENTLY here.');
  expect(band.querySelector('.ib-lt-at')).not.toBeNull();
  expect(comments()).toEqual([]);
  act(() => band.click());
  // The host moves it: the band only records the choice.
  expect(fileThreadOpen(memory, 'W1')).toBe(true);
  drawFile(true);
  expect(box().hasAttribute('data-open')).toBe(true);
  expect(comments()).toEqual(['w1', 'w2']);
  expect(host.querySelector('a[aria-label="Open this thread on GitHub"]')!.getAttribute('href')).toBe('https://github.com/acme/web/pull/7#discussion_w1');
  act(() => (host.querySelector('[data-pull-thread-refold]') as HTMLElement).click());
  expect(fileThreadOpen(memory, 'W1')).toBe(false);
});
