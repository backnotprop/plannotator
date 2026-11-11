import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { sidebarUpdateNotice, updateForPage } from './updateNotice';
import type { SidebarToggleNotice } from './shell/sidebar';

const hasDom = typeof document !== 'undefined';
const { SidebarProvider, SidebarTrigger } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedMatchMedia: typeof window.matchMedia | undefined;
let phone = false;

beforeEach(() => {
  if (!hasDom) return;
  phone = false;
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query.includes('max-width: 767px') ? phone : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
});

function render(open: boolean, notice: SidebarToggleNotice | null): HTMLButtonElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider open={open} onOpenChange={() => {}} toggleNotice={notice}>
        <SidebarTrigger />
      </SidebarProvider>,
    );
  });
  return host.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
}

const dot = (button: HTMLElement) => button.querySelector<HTMLElement>('.ib-sb-trigger-dot');

test('the notice follows what the Update button offers', () => {
  expect(sidebarUpdateNotice('available', false)).toEqual({ tone: 'primary', label: 'update available' });
  expect(sidebarUpdateNotice('ready', false)).toEqual({ tone: 'primary', label: 'update ready' });
  expect(sidebarUpdateNotice('failed', false)).toEqual({ tone: 'neutral', label: 'update failed' });
  expect(sidebarUpdateNotice('updating', false)).toBeNull();
  expect(sidebarUpdateNotice('available', true)).toBeNull();
  expect(sidebarUpdateNotice(null, false)).toBeNull();
});

test('a guest over the tailnet is offered no update (the update routes answer it 403 local_only); the owner is', () => {
  const update = { available: true, state: 'available', version: '9.9.9', current: '0.28.0', action: 'script', releaseUrl: '' } as const;
  type Update = Parameters<typeof updateForPage>[0];
  const offered = update as unknown as Update;
  expect(updateForPage(offered, { via: 'local' })).toBe(offered);
  expect(updateForPage(offered, {})).toBe(offered);
  expect(updateForPage(offered, { via: 'tailnet', guest: false })).toBe(offered);
  expect(updateForPage(offered, { via: 'tailnet', guest: true })).toBeNull();
  expect(sidebarUpdateNotice(updateForPage(offered, { via: 'tailnet', guest: true })?.state, false)).toBeNull();
  expect(updateForPage(offered, { via: 'tailnet' })).toBeNull();
  expect(updateForPage(offered, null)).toBeNull();
  expect(updateForPage(null, { via: 'local' })).toBeNull();
});

test.skipIf(!hasDom)('closed sidebar with an update: the dot, hidden from screen readers, and the name says it', () => {
  const button = render(false, sidebarUpdateNotice('available', false));
  expect(dot(button)).not.toBeNull();
  expect(dot(button)!.getAttribute('aria-hidden')).toBe('true');
  expect(dot(button)!.dataset.tone).toBe('primary');
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar, update available');
  expect(button.hasAttribute('title')).toBe(false);
});

test.skipIf(!hasDom)('ready and failed name their state; failed is the neutral tone', () => {
  let button = render(false, sidebarUpdateNotice('ready', false));
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar, update ready');
  act(() => root?.unmount());
  host?.remove();
  button = render(false, sidebarUpdateNotice('failed', false));
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar, update failed');
  expect(dot(button)!.dataset.tone).toBe('neutral');
});

test.skipIf(!hasDom)('open sidebar: no dot, the plain name (the Update button itself is in view)', () => {
  const button = render(true, sidebarUpdateNotice('available', false));
  expect(dot(button)).toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar');
});

test.skipIf(!hasDom)('no update: no dot', () => {
  const button = render(false, sidebarUpdateNotice(null, false));
  expect(dot(button)).toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar');
});

test.skipIf(!hasDom)('a phone: the sheet closed shows the dot, the sheet open hides it', () => {
  phone = true;
  const button = render(true, sidebarUpdateNotice('ready', false));
  expect(dot(button)).not.toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Toggle Sidebar, update ready');
  act(() => button.click());
  expect(dot(host!.querySelector<HTMLElement>('[data-sidebar="trigger"]')!)).toBeNull();
});
