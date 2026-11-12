import { afterEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';

const hasDom = typeof document !== 'undefined';
const gone = () => {
  throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/gone.js');
};
if (hasDom) {
  mock.module('#platform-post', gone);
  mock.module('#search-palette', gone);
  mock.module('#shape-board', gone);
}
const { PostEnding } = (hasDom ? await import('./pulls/PostEnding') : {}) as typeof import('./pulls/PostEnding');
const { SearchHost } = (hasDom ? await import('./components/SearchHost') : {}) as typeof import('./components/SearchHost');
const { ShapeLayer } = (hasDom ? await import('./shape/ShapeParts') : {}) as typeof import('./shape/ShapeParts');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

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
  const notice = host!.querySelector('[data-review-posts] [data-lazy-load-failed]');
  expect(notice !== null).toBe(true);
  expect(notice!.querySelector('button') !== null).toBe(true);
  expect(primary().disabled).toBe(false);
  mock.module('#platform-post', () => ({ default: ({ open }: { open: unknown }) => (open ? <div data-post-dialog="" /> : null) }));
  await act(async () => primary().click());
  await settle();
  expect(host!.querySelector('[data-post-dialog]') !== null).toBe(true);
  expect(host!.querySelector('[data-lazy-load-failed]') !== null).toBe(false);
});

test.skipIf(!hasDom)('a palette whose chunk cannot arrive closes the search state, and the next open loads it', async () => {
  const closes: string[] = [];
  let openSearch: () => void = () => {};
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
  mock.module('#search-palette', () => ({ default: ({ open }: { open: boolean }) => (open ? <div data-palette="" /> : null) }));
  await act(async () => openSearch());
  await settle();
  expect(host!.querySelector('[data-palette]') !== null).toBe(true);
  expect(host!.querySelector('[data-search-open]')!.getAttribute('data-search-open')).toBe('yes');
  expect(closes).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('a Shape board whose chunk cannot arrive says so, and the next open loads it', async () => {
  let setOpen: (id: string | null) => void = () => {};
  function Window() {
    const [id, set] = useState<string | null>(null);
    setOpen = set;
    return id ? (
      <SidebarProvider open onOpenChange={() => {}}>
        <ShapeLayer host={{} as ShapeHost} id={id} thread={null} onClose={() => set(null)} />
      </SidebarProvider>
    ) : null;
  }
  mount(<Window />);
  await act(async () => setOpen('shp_1'));
  await settle();
  expect(host!.querySelector('[data-shape-layer] [data-lazy-load-failed]') !== null).toBe(true);
  mock.module('#shape-board', () => ({ default: ({ id }: { id: string }) => <div data-board={id} /> }));
  await act(async () => setOpen(null));
  await act(async () => setOpen('shp_1'));
  await settle();
  expect(host!.querySelector('[data-board="shp_1"]') !== null).toBe(true);
  expect(host!.querySelector('[data-lazy-load-failed]') !== null).toBe(false);
});
