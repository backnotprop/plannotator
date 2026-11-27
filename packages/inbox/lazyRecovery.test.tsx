/**
 * The post dialog and the search palette are chunks the Inbox serves on first
 * use (lazyParts.tsx, #2593). When one cannot arrive (the Inbox stopped for a
 * moment), the window must stay usable and ask again once the Inbox is back.
 * What regresses:
 *
 *  - PostEnding: Post and "Comment…" left disabled until a reload, with no
 *    word, because the dialog's open state was never cleared;
 *  - ⌘K: the palette's boundary stays failed and React.lazy keeps its
 *    rejection, so ⌘K never opens search again; and the window's search state
 *    stays open, which keeps the list intro off.
 *
 * The chunk fails as a missing one does; it is then served again by mocking
 * the module once more.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const gone = () => {
  throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/gone.js');
};
if (hasDom) {
  mock.module('#platform-post', gone);
  mock.module('#search-palette', gone);
}
const { PostEnding } = (hasDom ? await import('./pulls/PostEnding') : {}) as typeof import('./pulls/PostEnding');
const { SearchHost } = (hasDom ? await import('./components/SearchHost') : {}) as typeof import('./components/SearchHost');

let root: Root | null = null;
let host: HTMLElement | null = null;
let silence: typeof console.error | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (silence) console.error = silence;
  silence = null;
});

function mount(node: React.ReactNode) {
  // React and the boundary log the failed chunk; the test reads the screen instead.
  silence = console.error;
  console.error = () => {};
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const pull: InboxPull = {
  key: 'github.com/northwind/billing-svc#880',
  platform: 'github',
  host: 'github.com',
  repo: 'northwind/billing-svc',
  number: 880,
  url: 'https://github.com/northwind/billing-svc/pull/880',
  title: 'Retry the failed charges',
  author: 'dana',
  mine: false,
  requested: true,
  state: 'open',
  base: 'main',
  head: 'retries',
  head_repo: 'northwind/billing-svc',
  head_sha: 'a'.repeat(40),
  additions: 4,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
} as InboxPull;

test.skipIf(!hasDom)('a post dialog whose chunk cannot arrive says so beside Post, Post stays usable, and the next click asks again', async () => {
  mount(<PostEnding pull={pull} agent={null} comments={[]} anchor="diff" busy={false} picked="forge" onPick={() => {}} onPosted={() => {}} />);
  const primary = () => host!.querySelector<HTMLButtonElement>('[data-review-posts] [data-decision-primary]')!;
  expect(primary() !== null).toBe(true);
  await act(async () => primary().click());
  await settle();
  // ui's notice (with Reload) beside the control, and the control not stuck disabled.
  const notice = host!.querySelector('[data-review-posts] [data-lazy-load-failed]');
  expect(notice !== null).toBe(true);
  expect(notice!.querySelector('button') !== null).toBe(true);
  expect(primary().disabled).toBe(false);
  // The Inbox is back: the next Post opens the dialog, and the notice goes.
  mock.module('#platform-post', () => ({ default: ({ open }: { open: unknown }) => (open ? <div data-post-dialog="" /> : null) }));
  await act(async () => primary().click());
  await settle();
  expect(host!.querySelector('[data-post-dialog]') !== null).toBe(true);
  expect(host!.querySelector('[data-lazy-load-failed]') !== null).toBe(false);
});

test.skipIf(!hasDom)('a palette whose chunk cannot arrive closes the search state, and the next open loads it', async () => {
  const closes: string[] = [];
  let openSearch: () => void = () => {};
  /** The window's search state, as App keeps it (searchMounted, searchOpen, closeSearch). */
  function Window() {
    const [mounted, setMounted] = useState(false);
    const [open, setOpen] = useState(false);
    openSearch = () => {
      setMounted(true);
      setOpen(true);
    };
    return (
      <>
        <p data-search-open={open ? 'yes' : 'no'} />
        <SearchHost
          mounted={mounted}
          open={open}
          phone={false}
          currentProject={null}
          projects={[]}
          onClose={(reason) => {
            closes.push(reason);
            setOpen(false);
          }}
          onOpenResult={() => {}}
        />
      </>
    );
  }
  mount(<Window />);
  await act(async () => openSearch());
  await settle();
  expect(closes).toEqual(['dismissed']);
  expect(host!.querySelector('[data-search-open]')!.getAttribute('data-search-open')).toBe('no');
  // The Inbox is back: ⌘K opens the palette.
  mock.module('#search-palette', () => ({ default: ({ open }: { open: boolean }) => (open ? <div data-palette="" /> : null) }));
  await act(async () => openSearch());
  await settle();
  expect(host!.querySelector('[data-palette]') !== null).toBe(true);
  expect(host!.querySelector('[data-search-open]')!.getAttribute('data-search-open')).toBe('yes');
  expect(closes).toEqual(['dismissed']);
});
