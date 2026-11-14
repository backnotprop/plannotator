/** Real app integration for compact panel gestures (DOM_TESTS=1). */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../ui/config';
import { PANEL_TRANSITION_MS } from '../ui/hooks/usePanelPresence';
import { resetStorageBackend, setStorageBackend } from '../ui/utils/storage';

// Only the Vite worker loader is replaced; the app shells and panels are real.
mock.module('../review-editor/workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== 'undefined';
const Editor = hasDom ? (await import('./App')).default : null;
const Review = hasDom ? (await import('../review-editor/App')).default : null;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;
const memory = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

class SilentEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 1;
  onmessage = null;
  onerror = null;
  onopen = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

type Mode = 'plan' | 'annotate' | 'review';
const PATCH = 'diff --git a/example.ts b/example.ts\nindex 0000001..0000002 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n';

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function mount(mode: Mode, compact = true, reduced = false, hasHeadings = true) {
  setStorageBackend({
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value); },
    removeItem: key => { memory.delete(key); },
  });
  for (const [key, value] of Object.entries({
    'plannotator-look-feel-announcement-seen': '2',
    'plannotator-plan-look-choice-resolved': 'true',
    'plannotator-announce-tui-herdr-seen': '1',
    'plannotator-announce-inbox-seen': '1',
    'plannotator-vim-mode-announcement-seen': '2',
    'plannotator-plan-ai-announcement-seen': '1',
    'plannotator-guide-intro-seen': '2',
    'plannotator-guide-hint-acked': 'true',
    'plannotator-edit-mode-announcement-seen': '3',
    'plannotator-token-hover-announcement-seen': '1',
    'plannotator-review-dest-spotlight-seen': '1',
  })) memory.set(key, value);
  configStore.loadFromBackend();
  window.matchMedia = ((query: string) => ({
    matches: (compact && query.includes('pointer: coarse')) || (reduced && query.includes('prefers-reduced-motion')),
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (raw.startsWith('https://')) return new Response(null, { status: 404 });
    const { pathname } = new URL(raw, 'http://localhost');
    if (pathname === '/api/plan') return Response.json({
      plan: hasHeadings ? '# Swipe test\n\nA document to review.\n\n## Second heading\n\nMore text.' : 'A paragraph without headings.',
      origin: 'codex', sharingEnabled: false, serverConfig: {},
      ...(mode === 'annotate' ? { mode: 'annotate', filePath: '/repo/notes.md' } : {}),
    });
    if (pathname === '/api/diff') return Response.json({
      rawPatch: PATCH, gitRef: 'HEAD', snapshotId: 'swipe-test',
      origin: 'codex', diffType: 'uncommitted', sharingEnabled: false, serverConfig: {},
    });
    if (pathname === '/api/diff/fresh') return Response.json({ fresh: true });
    if (pathname === '/api/ai/capabilities') return Response.json({ available: false, providers: [] });
    if (pathname === '/api/draft') return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const App = mode === 'review' ? Review! : Editor!;
  await act(async () => root?.render(<App />));
  const ready = () => mode === 'review'
    ? !!host?.querySelector('[aria-label="Open review navigation"]')
      || (!compact && !!host?.textContent?.includes('example.ts'))
    : !!document.getElementById('pn-compact-plan-navigator-trigger')
      || ((!compact || !hasHeadings) && !!host?.querySelector('[data-block-id]'));
  for (let i = 0; i < 40 && !ready(); i++) await settle();
  expect(ready()).toBe(true);
  await settle();
}

async function swipe(
  side: 'left' | 'right',
  target = host!.querySelector('[data-pn-browser-canvas]')!,
  closing = false,
) {
  expect(target).not.toBeNull();
  const width = window.innerWidth;
  const start = closing ? width / 2 : side === 'left' ? 8 : width - 8;
  const distance = side === 'left' ? width * 0.4 : 120;
  const end = start + distance * ((side === 'left') !== closing ? 1 : -1);
  let preventedScroll = false;
  await act(async () => {
    for (const [type, x] of [['touchstart', start], ['touchmove', end], ['touchend', end]] as const) {
      const point = { identifier: 1, clientX: x, clientY: 150 };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [point] },
        changedTouches: { value: [point] },
      });
      target.dispatchEvent(event);
      if (type === 'touchmove') preventedScroll = event.defaultPrevented;
    }
  });
  await settle();
  return preventedScroll;
}

const navigation = (mode: Mode) => document.querySelector(
  `[role="dialog"][aria-label="${mode === 'review' ? 'Review navigation' : 'Plan navigator'}"]:not([aria-hidden="true"])`,
);
const optionsMenu = () => document.querySelector(
  '[data-pn-options-menu]:not([aria-hidden="true"])',
);
const annotationSurface = (mode: Mode) => document.querySelector(
  `[role="dialog"][aria-label="${mode === 'review' ? 'Review sidebar' : 'Annotations'}"]:not([aria-hidden="true"])`,
);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    document.body.replaceChildren();
  }
  memory.clear();
  resetStorageBackend();
  configStore.loadFromBackend();
});


async function openPanel(mode: Mode, side: 'left' | 'right') {
  const trigger = side === 'right'
    ? host!.querySelector<HTMLButtonElement>('button[aria-label="Options"]')
    : mode === 'review'
      ? host!.querySelector<HTMLButtonElement>('[aria-label="Open review navigation"]')
      : document.getElementById('pn-compact-plan-navigator-trigger') as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  await settle();
}

describe.if(hasDom)('mobile panel closing and memory in real app shells', () => {
  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test(`${mode}: edge swipes stay native, buttons open panels and inside swipes close them`, async () => {
      await mount(mode);
      for (const side of ['left', 'right'] as const) {
        expect(await swipe(side)).toBe(false);
        expect(navigation(mode)).toBeNull();
        expect(optionsMenu()).toBeNull();
        await openPanel(mode, side);
        const panel = side === 'left' ? navigation(mode)! : optionsMenu()!;
        expect(panel).not.toBeNull();
        expect(await swipe(side, panel, true)).toBe(true);
        expect(side === 'left' ? navigation(mode) : optionsMenu()).toBeNull();
        await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      }
    });

    test(`${mode}: Options opens annotations, which close by an inside swipe`, async () => {
      await mount(mode);
      await openPanel(mode, 'right');
      const item = Array.from(optionsMenu()!.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.trim() === 'Annotations')!;
      expect(item).toBeDefined();
      await act(async () => item.click());
      expect(optionsMenu()).toBeNull();
      const panel = annotationSurface(mode)!;
      expect(panel).not.toBeNull();
      expect(await swipe('right', panel, true)).toBe(true);
      expect(annotationSurface(mode)).toBeNull();
    });

    test(`${mode}: navigation restores scroll after closing and remounting`, async () => {
      await mount(mode);
      await openPanel(mode, 'left');
      const panel = navigation(mode)!;
      const viewport = Array.from(panel.querySelectorAll<HTMLElement>('div')).find(el => el.style.overflowY === 'auto')!;
      expect(viewport).toBeDefined();
      viewport.scrollTop = 320;
      viewport.dispatchEvent(new Event('scroll'));
      await swipe('left', panel, true);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      expect(panel.isConnected).toBe(false);
      await openPanel(mode, 'left');
      const restored = Array.from(navigation(mode)!.querySelectorAll<HTMLElement>('div')).find(el => el.style.overflowY === 'auto')!;
      expect(restored).not.toBe(viewport);
      expect(restored.scrollTop).toBe(320);
    });

    test(`${mode}: reduced motion still allows swipe-to-close`, async () => {
      await mount(mode, true, true);
      await openPanel(mode, 'left');
      const panel = navigation(mode)!;
      await swipe('left', panel, true);
      expect(panel.isConnected).toBe(false);
    });
  }
});
