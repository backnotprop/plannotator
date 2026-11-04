/**
 * How the Pull requests list is read for the page and for the sidebar's count (`usePulls`). What regresses:
 *  - the count read on every focus (a GraphQL call per host each time) instead of at most every 20 s;
 *  - the count never read until the page is opened;
 *  - leaving the page dropping a read already on its way, so the count stays stale until the next focus;
 *  - a read kept going (and the forges asked on focus) once Code review is off.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { usePulls, PULLS_FOCUS_MS } = (hasDom ? await import('./usePulls') : {}) as typeof import('./usePulls');

const ANSWER: InboxPullsAnswer = { fetched_at: '2026-11-04T09:00:00.000Z', hosts: [], pulls: [], links: {}, projects: {}, cards: {} };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let now = 1_800_000_000_000;
let clock: { mockRestore: () => void } | null = null;
/** Each read of the list, with its signal, answered when the test says. */
let reads: { signal: AbortSignal | undefined; answer: () => void }[] = [];
let seen: ReturnType<typeof usePulls> | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  reads = [];
  seen = null;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://inbox.test');
    if (!url.pathname.endsWith('/api/inbox/pulls')) return Promise.resolve(Response.json({}));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      reads.push({ signal: init?.signal ?? undefined, answer: () => resolve(Response.json({ serverSession: 's', ...ANSWER })) });
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

function Probe({ enabled, counted }: { enabled: boolean; counted: boolean }) {
  seen = usePulls(enabled, counted);
  return null;
}

function render(enabled: boolean, counted: boolean) {
  act(() => {
    if (!root) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    root.render(<Probe enabled={enabled} counted={counted} />);
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
  // Not dropped, and not asked again.
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
