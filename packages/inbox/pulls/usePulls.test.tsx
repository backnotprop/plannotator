import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { usePulls, PULLS_FOCUS_MS, PULLS_PENDING_MS } = (hasDom ? await import('./usePulls') : {}) as typeof import('./usePulls');

const ANSWER: InboxPullsAnswer = { fetched_at: '2026-11-04T09:00:00.000Z', hosts: [], pulls: [], links: {}, projects: {}, cards: {} };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let now = 1_800_000_000_000;
let clock: { mockRestore: () => void } | null = null;
let reads: { url: URL; signal: AbortSignal | undefined; answer: (over?: Partial<InboxPullsAnswer>) => void }[] = [];
let seen: ReturnType<typeof usePulls> | null = null;
let cachedReads: { signal: AbortSignal | undefined; answer: (body: unknown) => void }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  reads = [];
  cachedReads = [];
  seen = null;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://inbox.test');
    if (url.searchParams.get('cached') === '1') {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        cachedReads.push({ signal: init?.signal ?? undefined, answer: (body) => resolve(Response.json(body)) });
      });
    }
    if (!url.pathname.endsWith('/api/inbox/pulls')) return Promise.resolve(Response.json({ rows: ['from the full read'] }));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      reads.push({ url, signal: init?.signal ?? undefined, answer: (over = {}) => resolve(Response.json({ serverSession: 's', ...ANSWER, ...over })) });
    });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clock?.mockRestore();
  globalThis.fetch = savedFetch;
});

function Probe({ enabled, counted, others }: { enabled: boolean; counted: boolean; others: boolean }) {
  seen = usePulls(enabled, counted, others);
  return null;
}

function render(enabled: boolean, counted: boolean, others = false) {
  act(() => {
    if (!root) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    root.render(<Probe enabled={enabled} counted={counted} others={others} />);
  });
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const focus = () => act(() => window.dispatchEvent(new Event('focus')));

test.skipIf(!hasDom)('the count alone: read when the window starts, then on focus at most every 20 s', async () => {
  render(false, true);
  expect(reads).toHaveLength(1);
  reads[0]!.answer();
  await settle();
  expect(seen!.model).not.toBeNull();
  now += PULLS_FOCUS_MS - 1;
  focus();
  expect(reads).toHaveLength(1);
  now += 1;
  focus();
  expect(reads).toHaveLength(2);
});

test.skipIf(!hasDom)('leaving the page keeps a read on its way: its answer is the count', async () => {
  render(true, true);
  expect(reads).toHaveLength(1);
  render(false, true);
  expect(reads[0]!.signal?.aborted).toBe(false);
  expect(reads).toHaveLength(1);
  reads[0]!.answer();
  await settle();
  expect(seen!.model?.fetched_at).toBe(ANSWER.fetched_at);
  expect(seen!.loading).toBe(false);
});

test.skipIf(!hasDom)('Code review off: a read on its way is dropped, and focus asks nothing', async () => {
  render(true, true);
  expect(reads).toHaveLength(1);
  render(false, false);
  expect(reads[0]!.signal?.aborted).toBe(true);
  now += PULLS_FOCUS_MS * 2;
  focus();
  expect(reads).toHaveLength(1);
  expect(seen!.loading).toBe(false);
});

test.skipIf(!hasDom)('the Others view: opening it reads at once, asking for Others; closed, Others is not asked', async () => {
  render(true, true);
  expect(reads[0]!.url.searchParams.get('others')).toBeNull();
  reads[0]!.answer();
  await settle();
  render(true, true, true);
  expect(reads).toHaveLength(2);
  expect(reads[1]!.url.searchParams.get('others')).toBe('1');
  reads[1]!.answer();
  await settle();
  render(false, true, false);
  now += PULLS_FOCUS_MS;
  focus();
  expect(reads).toHaveLength(3);
  expect(reads[2]!.url.searchParams.get('others')).toBeNull();
});

test.skipIf(!hasDom)("Others on its way: asked again shortly, until it has answered", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers: { fn: () => void; ms: number }[] = [];
  // Only the pending re-read's timer is held for the test to fire; every other timer runs as asked.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => (ms === PULLS_PENDING_MS ? (timers.push({ fn, ms }), 0) : realSetTimeout(fn, ms))) as unknown as typeof setTimeout;
  try {
    render(true, true);
    reads[0]!.answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', others_pending: true }] });
    await settle();
    expect(timers).toHaveLength(1);
    act(() => timers.shift()!.fn());
    expect(reads).toHaveLength(2);
    reads[1]!.answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }] });
    await settle();
    expect(timers).toHaveLength(0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test.skipIf(!hasDom)('the rows from the cache: "nothing read yet" keeps what is there, and a full read outranks one still on its way', async () => {
  render(true, true);
  reads[0]!.answer();
  await settle();
  const full = seen!.reviews;
  expect(full).not.toBeNull();

  act(() => seen!.reloadRows());
  cachedReads[0]!.answer({ cold: true });
  await settle();
  expect(seen!.reviews).toBe(full);

  act(() => seen!.reloadRows());
  act(() => seen!.refresh());
  expect(cachedReads[1]!.signal?.aborted).toBe(true);
});
