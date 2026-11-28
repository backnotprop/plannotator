/**
 * Whole file in the Inbox's diff controls (review parity, B0). The Inbox's
 * diffs obey code review's "Whole file" switch (`diffExpandUnchanged`: the
 * `plannotator-diff-expand-unchanged` cookie and config.json
 * `diffOptions.expandUnchanged`), so its "Diff display" popover must carry
 * that switch: hidden, a person who once chose Whole file in code review gets
 * whole files in the Inbox with no way back. A phone keeps the gear alone, so
 * the switch is still reachable there.
 *
 * The failures this catches: the switch missing from the popover (desktop or
 * phone), a click that does not reach the setting or the Inbox's settings
 * write (`diff_options.expand_unchanged`), config.json's Whole file not
 * adopted on load, and Hide whitespace (which needs the local repository)
 * offered in the Inbox.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { DiffControls } = (hasDom ? await import('./DiffControls') : {}) as typeof import('./DiffControls');
const { adoptSavedDiffOptions, diffOptionsToWire, resetInboxDiffOptionsForTests } = (hasDom ? await import('../diffOptions') : {}) as typeof import('../diffOptions');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');

let root: Root | null = null;
let host: HTMLElement | null = null;
let phone = false;
let savedFetch: typeof fetch;
let savedMatchMedia: typeof window.matchMedia;
let synced: Record<string, unknown>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  // Cookies need a page address (happy-dom starts on about:blank).
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  phone = false;
  synced = [];
  resetInboxDiffOptionsForTests();
  configStore.set('diffExpandUnchanged', false);
  configStore.setServerSync((payload) => synced.push(payload));
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
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
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  configStore.set('diffExpandUnchanged', false);
  configStore.resetServerSync();
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatchMedia;
  resetInboxDiffOptionsForTests();
});

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<DiffControls files={2} collapseAll={null} onCollapseAll={() => {}} />);
  });
  return host;
}

async function openPopover(el: HTMLElement) {
  act(() => el.querySelector<HTMLButtonElement>('[data-diff-display-options]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-diff-display-popup]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  const popup = document.querySelector<HTMLElement>('[data-diff-display-popup]');
  expect(popup).not.toBeNull();
  return popup!;
}

const wholeFile = (popup: HTMLElement) => [...popup.querySelectorAll<HTMLElement>('[role="switch"]')].find((s) => s.textContent === 'Whole file');

/** Waits out the config store's batched server write. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

test.skipIf(!hasDom)('the popover has Whole file and no Hide whitespace; turning it on and off reaches the setting and the Inbox settings write', async () => {
  const el = mount();
  const popup = await openPopover(el);
  const sw = wholeFile(popup);
  expect(sw).toBeDefined();
  expect(sw!.getAttribute('aria-checked')).toBe('false');
  expect(popup.textContent).not.toContain('Hide whitespace');

  act(() => sw!.click());
  expect(configStore.get('diffExpandUnchanged')).toBe(true);
  expect(document.cookie).toContain('plannotator-diff-expand-unchanged=true');
  expect(wholeFile(popup)!.getAttribute('aria-checked')).toBe('true');
  await settle();
  expect(diffOptionsToWire(synced.at(-1)?.diffOptions)).toMatchObject({ expand_unchanged: true });

  act(() => wholeFile(popup)!.click());
  expect(configStore.get('diffExpandUnchanged')).toBe(false);
  await settle();
  expect(diffOptionsToWire(synced.at(-1)?.diffOptions)).toMatchObject({ expand_unchanged: false });
});

test.skipIf(!hasDom)('a phone keeps the gear alone, and its popover has Whole file', async () => {
  phone = true;
  configStore.set('diffExpandUnchanged', true);
  const el = mount();
  expect([...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Diff display options']);
  const popup = await openPopover(el);
  expect(popup.hasAttribute('data-pn-compact-diff-options')).toBe(true);
  const sw = wholeFile(popup);
  expect(sw!.getAttribute('aria-checked')).toBe('true');
  act(() => sw!.click());
  expect(configStore.get('diffExpandUnchanged')).toBe(false);
});

test.skipIf(!hasDom)("config.json's Whole file (as code review saved it) is the one the Inbox opens on", () => {
  expect(configStore.get('diffExpandUnchanged')).toBe(false);
  adoptSavedDiffOptions({ expand_unchanged: true });
  expect(configStore.get('diffExpandUnchanged')).toBe(true);
});
