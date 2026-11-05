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

async function mount(mode: Mode, compact = true, reduced = false) {
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
      plan: '# Swipe test\n\nA document to review.\n\n## Second heading\n\nMore text.',
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
      || (!compact && !!host?.querySelector('[data-block-id]'));
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
  const start = closing ? 200 : side === 'left' ? 8 : window.innerWidth - 8;
  const end = closing ? (side === 'left' ? 100 : 300) : side === 'left' ? 90 : window.innerWidth - 90;
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
const annotations = (mode: Mode) => document.querySelector(
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

describe.if(hasDom)('mobile edge swipes in real app shells', () => {
  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test(`${mode}: navigation restores scroll position after its exit and remount`, async () => {
      await mount(mode);
      await swipe('left');
      const panel = navigation(mode)!;
      const viewport = Array.from(panel.querySelectorAll<HTMLElement>('div')).find(el => el.style.overflowY === 'auto');
      expect(viewport).toBeDefined();
      viewport!.scrollTop = 320;
      viewport!.dispatchEvent(new Event('scroll'));
      await swipe('left', panel, true);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      expect(panel.isConnected).toBe(false);
      await swipe('left');
      const restored = Array.from(navigation(mode)!.querySelectorAll<HTMLElement>('div')).find(el => el.style.overflowY === 'auto');
      expect(restored).not.toBe(viewport);
      expect(restored!.scrollTop).toBe(320);
    });

    test(`${mode}: closing by swipe or button retains inert panels until the exit finishes`, async () => {
      await mount(mode);
      await swipe('left');
      const left = navigation(mode)!;
      expect(left.getAttribute('data-pn-panel-side')).toBe('left');
      expect(left.getAttribute('data-pn-panel-state')).toBe('open');
      await swipe('left', left, true);
      expect(left.isConnected).toBe(true);
      expect(left.getAttribute('data-pn-panel-state')).toBe('closed');
      expect(left.hasAttribute('inert')).toBe(true);
      expect(left.getAttribute('aria-hidden')).toBe('true');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      expect(left.isConnected).toBe(false);
      await swipe('right');
      const right = annotations(mode)!;
      expect(right.getAttribute('data-pn-panel-side')).toBe('right');
      await act(async () => right.querySelector<HTMLButtonElement>('button[aria-label^="Close"]')!.click());
      expect(right.isConnected).toBe(true);
      expect(right.hasAttribute('inert')).toBe(true);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      expect(right.isConnected).toBe(false);
    });

    test(`${mode}: reopening during exit keeps the same interactive panel mounted`, async () => {
      await mount(mode);
      await swipe('right');
      const panel = annotations(mode)!;
      await swipe('right', panel, true);
      expect(panel.isConnected).toBe(true);
      expect(await swipe('right')).toBe(true);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
      expect(annotations(mode)).toBe(panel);
      expect(panel.hasAttribute('inert')).toBe(false);
      expect(panel.getAttribute('data-pn-panel-state')).toBe('open');
    });

    test(`${mode}: reduced motion closes without waiting for an animation`, async () => {
      await mount(mode, true, true);
      await swipe('left');
      const panel = navigation(mode)!;
      await swipe('left', panel, true);
      expect(panel.isConnected).toBe(false);
    });

    test(`${mode}: inward swipes open panels and outward swipes inside them close and allow reopening`, async () => {
      await mount(mode);
      expect(navigation(mode)).toBeNull();
      expect(annotations(mode)).toBeNull();
      expect(await swipe('left')).toBe(true);
      expect(navigation(mode)).not.toBeNull();
      expect(annotations(mode)).toBeNull();
      expect(navigation(mode)!.textContent).toContain(mode === 'review' ? 'example.ts' : 'Second heading');
      await swipe('right');
      expect(navigation(mode)).not.toBeNull();
      expect(annotations(mode)).toBeNull();
      expect(await swipe('left', navigation(mode)!, true)).toBe(true);
      expect(navigation(mode)).toBeNull();
      expect(await swipe('right')).toBe(true);
      expect(annotations(mode)).not.toBeNull();
      expect(navigation(mode)).toBeNull();
      expect(annotations(mode)!.textContent).toContain('Annotations');
      expect(await swipe('right', annotations(mode)!, true)).toBe(true);
      expect(annotations(mode)).toBeNull();
      expect(await swipe('left')).toBe(true);
      expect(navigation(mode)).not.toBeNull();
    });

    test(`${mode}: an open annotations panel retains ownership of edge gestures`, async () => {
      await mount(mode);
      await swipe('right');
      const panel = annotations(mode);
      expect(panel).not.toBeNull();
      await swipe('left');
      expect(await swipe('right', panel!)).toBe(false);
      expect(annotations(mode)).toBe(panel);
      expect(navigation(mode)).toBeNull();
    });

    test(`${mode}: desktop edge touches never open compact panels`, async () => {
      await mount(mode, false);
      expect(await swipe('left')).toBe(false);
      expect(await swipe('right')).toBe(false);
      expect(navigation(mode)).toBeNull();
      expect(annotations(mode)).toBeNull();
    });
  }
});
