/**
 * A message's html block as an artifact in the window (htmlArtifactOpen.ts, components/HtmlArtifactOpen.tsx; the
 * owner, 2026-11-25: "Clicking it in Artifacts opens that same live block, big ... with the same annotate tools").
 * DOM-gated (DOM_TESTS=1). What would regress: the block's tile missing from the grid, not saying "in text", or
 * opening the file viewer (a block is not a file); the tile opening anything but the block's own page, big, served
 * as the block in the text is, on the block the text parses to (its place, so a comment there is the text's), with
 * the pen; the pen offered on a message whose text takes no comments; closing not coming back to the tile, or (from
 * the Wall) not going back to the Wall; and a request outliving its thread.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { MessageActs, MessageActsRef } from './parts/messageActs';

const hasDom = typeof document !== 'undefined';
const { ArtifactsView, HtmlArtifactOpen } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');
const { threadArtifacts } = (hasDom ? await import('./artifacts') : {}) as typeof import('./artifacts');
const { openHtmlArtifact, resetHtmlArtifactOpenForTest } = (hasDom ? await import('./htmlArtifactOpen') : {}) as typeof import('./htmlArtifactOpen');
const { resetArtifactPinsForTest } = (hasDom ? await import('./artifactPins') : {}) as typeof import('./artifactPins');
const { resetEmbedGateForTests } = (hasDom ? await import('@plannotator/ui/components/html-embed/loadGate') : {}) as typeof import('@plannotator/ui/components/html-embed/loadGate');
const { parseMarkdownToBlocks } = (hasDom ? await import('@plannotator/ui/utils/parser') : {}) as typeof import('@plannotator/ui/utils/parser');

const THREAD = 'msg_01M6XV5A40WH334FPF7KQQH5S5';
const EMBED_ID = '0123456789abcdef0123456789abcdef';
const TIDES = '<h2>Harbor · tide table</h2><table><tr><td>06:12</td></tr></table>';
const BERTHS = '<div id="chart"></div><script src="https://cdn.example/chart.js"></script>';
const BODY = ['Charlie Dunn asked for the Thursday plan.', '', '```html', TIDES, '```', '', 'Bob Tully checks the berths:', '', '```html', BERTHS, '```'].join('\n');

function message(): InboxMessageWire {
  return {
    id: THREAD,
    thread_id: THREAD,
    project_id: 'prj_01M6XV5A40WH334FPF7KQQH5S6',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_harbor', name: 'Claude Code' },
    body: BODY,
    created_at: '2026-11-25T09:00:00.000Z',
  } as unknown as InboxMessageWire;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let saved: unknown[] = [];
let embedded: string[] = [];
let restoreObserver: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  saved = [];
  embedded = [];
  resetEmbedGateForTests();
  resetHtmlArtifactOpenForTest();
  // Every tile and block is near (no IntersectionObserver): the block's page is asked for at once.
  const observer = (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  restoreObserver = () => {
    (globalThis as Record<string, unknown>).IntersectionObserver = observer;
  };
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/inbox/embeds' && init?.method === 'POST') {
      embedded.push(String(JSON.parse(String(init.body)).html));
      return new Response(JSON.stringify({ id: EMBED_ID, url: `/api/inbox/embeds/${EMBED_ID}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/inbox/artifact-pins')) return new Response(JSON.stringify({ pins: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = savedFetch;
  restoreObserver?.();
  restoreObserver = null;
  resetArtifactPinsForTest();
  resetHtmlArtifactOpenForTest();
  document.body.innerHTML = '';
});

const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const acts = (): MessageActsRef => ({ current: { saveMessageComment: async (_id: string, annotation: unknown) => (saved.push(annotation), true), noteUnanchored: () => {} } as unknown as MessageActs });

async function mount(comments: boolean): Promise<void> {
  const messages = [message()];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <>
        <ArtifactsView threadId={THREAD} artifacts={threadArtifacts(messages, [], [])} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />
        <HtmlArtifactOpen threadId={THREAD} messages={messages} commentsOf={() => (comments ? [] : null)} acts={acts()} />
      </>,
    );
  });
  await settle();
}

const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-artifacts-view] [data-artifact-tile]')];
const opened = () => document.querySelector<HTMLElement>('[data-html-embed-open]');

test("a block's tile is in the grid, in text, and opens the block's own page big, with the pen, on the block its text parses to", async () => {
  if (!hasDom) return;
  await mount(true);
  expect(tiles().map((tile) => tile.getAttribute('data-artifact-kind'))).toEqual(['html-block', 'html-block']);
  expect(tiles()[0]!.textContent).toContain('Harbor · tide table');
  expect(tiles()[1]!.textContent).toContain('HTML block');
  for (const tile of tiles()) expect(tile.textContent).toContain('in text');
  // The grid draws no live page: only the quiet frame that runs no script.
  expect(document.querySelectorAll('[data-artifacts-view] iframe[sandbox=""]').length).toBe(2);
  expect(embedded).toEqual([]);

  tiles()[1]!.focus();
  await act(async () => tiles()[1]!.click());
  await settle();
  const dialog = opened();
  expect(dialog).not.toBeNull();
  // The block the text draws second: its own source, served as the block in the text is (never as a file).
  const second = parseMarkdownToBlocks(BODY, { frontmatter: false }).filter((block) => block.type === 'code')[1]!;
  expect(dialog!.querySelector('figure[data-html-embed]')!.getAttribute('data-block-id')).toBe(second.id);
  expect(embedded).toEqual([BERTHS]);
  expect(dialog!.querySelector('iframe[data-html-embed-frame]')!.getAttribute('src')).toStartWith(`/api/inbox/embeds/${EMBED_ID}`);
  expect(document.querySelector('[data-attachment-pane]')).toBeNull();
  // The block's own tools: Code and the pen; not Full screen (it is open full).
  expect(dialog!.querySelector('[data-html-embed-annotate]')).not.toBeNull();
  expect(dialog!.querySelector('[data-html-embed-code]')).not.toBeNull();
  expect(dialog!.querySelector('[data-html-embed-full]')).toBeNull();

  // Closed: focus is back on the tile it was opened from.
  await act(async () => dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  await settle();
  expect(opened()).toBeNull();
  expect(document.activeElement).toBe(tiles()[1]!);
});

test('a message whose text takes no comments opens its block without the pen', async () => {
  if (!hasDom) return;
  await mount(false);
  await act(async () => tiles()[0]!.click());
  await settle();
  expect(opened()).not.toBeNull();
  expect(opened()!.querySelector('[data-html-embed-annotate]')).toBeNull();
});

test('opened from the Wall, closing goes back to the Wall; a block not in the thread opens nothing', async () => {
  if (!hasDom) return;
  window.location.hash = '#artifacts';
  const key = threadArtifacts([message()], [], []).find((artifact) => artifact.type === 'html')!;
  openHtmlArtifact(THREAD, key.type === 'html' ? key.key : '', { fromWall: true });
  window.location.hash = `#thread=${THREAD}&msg=${THREAD}`;
  await mount(true);
  expect(opened()).not.toBeNull();
  await act(async () => opened()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  await settle();
  expect(opened()).toBeNull();
  expect(window.location.hash).toBe('#artifacts');

  await act(async () => openHtmlArtifact(THREAD, `html:${THREAD}:ffffffffffffffff`));
  await settle();
  expect(opened()).toBeNull();
});
