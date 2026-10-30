/**
 * A lazy block whose chunk cannot load must not take the page down with it.
 * In the packed app builds the diagram, embed and preview components are
 * separate chunks fetched over the network; a rejected React.lazy import
 * with no boundary unmounts the whole React root, and the user's unsent
 * comments and edits vanish from the screen.
 *
 * What regresses if these fail:
 * - the boundary stops catching, so a failed chunk blanks the app again;
 * - the fallback stops showing the block's source and the Reload notice;
 * - a sibling remounts (or unmounts), losing state the user typed;
 * - a chunk the server answers with 404 (a tab older than the server's
 *   build) stops saying the app was updated;
 * - a block whose chunk loads shows the notice anyway.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act, lazy, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '../types';
import { DiagramBlockPending } from './diagram/DiagramPending';
import { failedChunkUrl, LazyBlockBoundary } from './LazyBlockBoundary';

const hasDom = typeof document !== 'undefined';

const mermaidBlock: Block = { id: 'm1', type: 'code', language: 'mermaid', content: 'flowchart LR\n  Kept --> Source', order: 0, startLine: 1 };

type HappyWindow = { happyDOM: { setURL: (url: string) => void } };
let previousUrl = '';
// A page served from a local port, as Plannotator's are: about:blank has no origin to compare against.
beforeAll(() => {
  if (!hasDom) return;
  previousUrl = window.location.href;
  (window as unknown as HappyWindow).happyDOM.setURL('http://localhost:19432/');
});
afterAll(() => {
  if (hasDom) (window as unknown as HappyWindow).happyDOM.setURL(previousUrl);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  while (restores.length > 0) restores.pop()!();
});

/** React reports a caught render error on console.error; keep the run quiet. */
function quietConsoleError(): void {
  const original = console.error;
  console.error = () => {};
  restores.push(() => {
    console.error = original;
  });
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Array<{ url: string; method?: string }> {
  const calls: Array<{ url: string; method?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return impl(input, init);
  }) as typeof fetch;
  restores.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const chunkUrl = () => `${window.location.origin}/assets/MermaidBlock-Old1234.js`;

/** A lazy component whose chunk never arrives, the way a browser reports it. */
const failingLazy = () =>
  lazy<React.FC>(() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${chunkUrl()}`)));

/** The page around the block: a field holding text the user has typed. */
const Sibling: React.FC = () => <textarea data-testid="draft" defaultValue="" />;

function page(Block: React.FC) {
  return (
    <div>
      <Sibling />
      <LazyBlockBoundary fallback={(notice) => <DiagramBlockPending block={mermaidBlock} kind="mermaid" notice={notice} />}>
        <Suspense fallback={<DiagramBlockPending block={mermaidBlock} kind="mermaid" />}>
          <Block />
        </Suspense>
      </LazyBlockBoundary>
    </div>
  );
}

describe('LazyBlockBoundary', () => {
  test.skipIf(!hasDom)('a failed chunk shows the source and a Reload notice, and the rest of the page stays mounted', async () => {
    quietConsoleError();
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const el = await mount(page(failingLazy()));
    const draft = el.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    draft.value = 'unsent comment';
    await settle();

    const notice = el.querySelector('[data-lazy-load-failed]');
    expect(notice?.textContent).toContain("Couldn't load this view.");
    expect(notice?.querySelector('button')?.textContent).toBe('Reload');
    // The block's source stays readable in its place; no pending status.
    expect(el.querySelector('[data-diagram-block="mermaid"] pre')?.textContent).toBe(mermaidBlock.content);
    expect(el.querySelector('[data-mermaid-pending]')).toBeNull();
    // Same node, same text: nothing above the boundary remounted.
    expect(el.querySelector('[data-testid="draft"]')).toBe(draft);
    expect(draft.value).toBe('unsent comment');
  });

  test.skipIf(!hasDom)('a chunk the server no longer has (404) says the app was updated', async () => {
    quietConsoleError();
    const calls = stubFetch(() => Promise.resolve(new Response('Not found', { status: 404 })));
    const el = await mount(page(failingLazy()));
    await settle();

    expect(calls).toEqual([{ url: chunkUrl(), method: 'HEAD' }]);
    const notice = el.querySelector('[data-lazy-load-failed]');
    expect(notice?.getAttribute('data-lazy-load-failed')).toBe('updated');
    expect(notice?.textContent).toContain('This page was updated.');
    expect(notice?.querySelector('button')?.textContent).toBe('Reload to see this');
  });

  test.skipIf(!hasDom)('a chunk that loads renders the block and nothing else', async () => {
    const calls = stubFetch(() => Promise.resolve(new Response('')));
    const Loaded = lazy<React.FC>(async () => ({ default: () => <p data-testid="block">diagram</p> }));
    const el = await mount(page(Loaded));
    await settle();

    expect(el.querySelector('[data-testid="block"]')?.textContent).toBe('diagram');
    expect(el.querySelector('[data-lazy-load-failed]')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('failedChunkUrl', () => {
  test.skipIf(!hasDom)('names only a same-origin URL from the error', () => {
    expect(failedChunkUrl(new TypeError(`Failed to fetch dynamically imported module: ${chunkUrl()}`))).toBe(chunkUrl());
    expect(failedChunkUrl(new Error('Unable to preload CSS for /assets/style-abc.css'))).toBe(`${window.location.origin}/assets/style-abc.css`);
    expect(failedChunkUrl(new TypeError('Importing a module script failed.'))).toBeNull();
    expect(failedChunkUrl(new TypeError('Failed to fetch dynamically imported module: https://cdn.example.com/x.js'))).toBeNull();
  });
});
