/**
 * Settings → Accounts → Linear keeps what the last Save or Remove said when the person leaves Settings and comes back:
 * the page's settings model is not reread after a save, so the row must not fall back to the key state it was first
 * given. A newer settings read (another object) wins again. The Inbox's answer is a stub; no key leaves the test.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLinearKeyState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { LinearKeySettings } = (hasDom ? await import('./components/LinearKeySettings') : {}) as typeof import('./components/LinearKeySettings');

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ key: { source: null, last4: null } })) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreFetch?.();
  restoreFetch = null;
});

function mount(initial: InboxLinearKeyState): string | null {
  act(() => root?.unmount());
  root = createRoot(host!);
  act(() => root!.render(<LinearKeySettings initial={initial} where="this computer" />));
  return host!.querySelector('[data-linear-key]')?.getAttribute('data-linear-key') ?? null;
}

test.skipIf(!hasDom)('after Remove, leaving Settings and coming back shows no key; a newer settings read wins', async () => {
  const read: InboxLinearKeyState = { source: 'saved', last4: '0000' };
  expect(mount(read)).toBe('saved');
  await act(async () => {
    (host!.querySelector('[data-linear-key-remove]') as HTMLButtonElement).click();
  });
  expect(host!.querySelector('[data-linear-key]')?.getAttribute('data-linear-key')).toBe('empty');
  // Back to Settings with the same (stale) settings read.
  expect(mount(read)).toBe('empty');
  // A fresh read of the settings says saved again: it wins.
  expect(mount({ source: 'saved', last4: '1111' })).toBe('saved');
});
