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

test.skipIf(!hasDom)('a saved key says whether Linear took it: refused after a bad key, accepted after a good one (a key saves either way)', async () => {
  const { installLinearCards } = await import('./linearCards');
  let verdict = 'refused';
  const uninstall = installLinearCards(async () => Response.json({ workspace: null, teams: [], key: verdict }));
  try {
    globalThis.fetch = (async () => Response.json({ key: { source: 'saved', last4: '9999' } })) as unknown as typeof fetch;
    const said = () => host!.querySelector('[data-linear-key-verdict]');
    mount({ source: 'saved', last4: '-key' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(said()?.getAttribute('data-linear-key-verdict')).toBe('refused');
    expect(said()?.textContent).toContain('Linear refused it');
    expect(host!.querySelector('[data-linear-key="saved"] svg')).toBeNull();
    // Replace it with a key Linear takes.
    await act(async () => {
      (host!.querySelector('[data-linear-key-replace]') as HTMLButtonElement).click();
    });
    const input = host!.querySelector('#ib-linear-key') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'lin_api_good');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    verdict = 'accepted';
    await act(async () => {
      (host!.querySelector('form[data-linear-key]') as HTMLFormElement).requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host!.querySelector('[data-linear-key]')?.getAttribute('data-linear-key')).toBe('saved');
    expect(said()?.textContent).toContain('Linear accepted it.');
    expect(host!.querySelector('[data-linear-key="saved"] svg')).not.toBeNull();
  } finally {
    act(() => uninstall());
  }
});
