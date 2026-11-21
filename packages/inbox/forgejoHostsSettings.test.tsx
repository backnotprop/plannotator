/**
 * Settings → Accounts → Forgejo and Gitea: add a host with a token, Check it, Replace and Remove; the row keeps what the
 * last answer said when the person leaves Settings and comes back; a host set in the environment cannot be removed here.
 * The Inbox's answers are a stub: no token leaves the test and none is shown by the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxForgejoHostsState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ForgejoHostsSettings } = (hasDom ? await import('./components/ForgejoHostsSettings') : {}) as typeof import('./components/ForgejoHostsSettings');

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreFetch: (() => void) | null = null;
let calls: Array<Record<string, unknown>> = [];
let answer: unknown = { hosts: [] };

beforeEach(() => {
  if (!hasDom) return;
  calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')));
    return Response.json(answer);
  }) as unknown as typeof fetch;
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
});

function mount(initial: InboxForgejoHostsState) {
  act(() => root?.unmount());
  root = createRoot(host!);
  act(() => root!.render(<ForgejoHostsSettings initial={initial} where="this computer" />));
}
const rows = () => [...host!.querySelectorAll('[data-forgejo-host]')].map((row) => row.getAttribute('data-forgejo-host'));
const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test.skipIf(!hasDom)('adding a host sends the address and token once, shows the saved row without the token, and survives leaving Settings', async () => {
  const empty: InboxForgejoHostsState = { hosts: [] };
  mount(empty);
  expect(rows()).toEqual(['codeberg.org']);
  answer = { hosts: [{ origin: 'https://git.example.com', hostSource: 'saved', token: { source: 'saved', last4: '1a2b' } }] };
  await type(host!.querySelector('#ib-forgejo-origin') as HTMLInputElement, 'git.example.com');
  await type(host!.querySelector('input[aria-label="Token (optional)"]') as HTMLInputElement, 'tok_secret_value_1a2b');
  await act(async () => (host!.querySelector('form[data-forgejo-add]') as HTMLFormElement).requestSubmit());
  await settle();
  expect(calls).toEqual([{ op: 'save', origin: 'git.example.com', token: 'tok_secret_value_1a2b', serverSession: calls[0]?.serverSession }].map((c) => ({ ...c })));
  expect(rows()).toEqual(['codeberg.org', 'https://git.example.com']);
  expect(host!.textContent).toContain('Token saved, ending in 1a2b');
  expect(host!.textContent).not.toContain('tok_secret_value');
  expect((host!.querySelector('#ib-forgejo-origin') as HTMLInputElement).value).toBe('');
  mount(empty);
  expect(rows()).toEqual(['codeberg.org', 'https://git.example.com']);
});

test.skipIf(!hasDom)('Check says what the host answered, and Remove drops the row', async () => {
  const saved: InboxForgejoHostsState = { hosts: [{ origin: 'https://git.example.com', hostSource: 'saved', token: { source: 'saved', last4: '1a2b' } }] };
  mount(saved);
  answer = { verdict: 'refused' };
  await act(async () => (host!.querySelector('[data-forgejo-check]') as HTMLButtonElement).click());
  await settle();
  expect(host!.querySelector('[data-forgejo-verdict]')?.getAttribute('data-forgejo-verdict')).toBe('refused');
  expect(host!.textContent).toContain('The host refused it');
  expect(host!.querySelector('[data-forgejo-host="https://git.example.com"] svg')).toBeNull();
  answer = { hosts: [] };
  await act(async () => (host!.querySelector('[data-forgejo-remove]') as HTMLButtonElement).click());
  await settle();
  expect(rows()).toEqual(['codeberg.org']);
});

test.skipIf(!hasDom)('a host set in the environment can be checked but not replaced or removed here', () => {
  mount({ hosts: [{ origin: 'https://git.env.example', hostSource: 'env', token: { source: 'env', last4: null } }] });
  expect(host!.querySelector('[data-forgejo-check]')).not.toBeNull();
  expect(host!.querySelector('[data-forgejo-remove]')).toBeNull();
  expect(host!.querySelector('[data-forgejo-replace]')).toBeNull();
  expect(host!.textContent).toContain('PLANNOTATOR_FORGEJO_TOKEN');
});

test.skipIf(!hasDom)('a refused save shows the Inbox\'s reason and keeps the form', async () => {
  mount({ hosts: [] });
  globalThis.fetch = (async () => Response.json({ error: 'origin: that doesn\'t look like an address.' }, { status: 400 })) as unknown as typeof fetch;
  await type(host!.querySelector('#ib-forgejo-origin') as HTMLInputElement, 'nope');
  await act(async () => (host!.querySelector('form[data-forgejo-add]') as HTMLFormElement).requestSubmit());
  await settle();
  expect(host!.querySelector('[role="alert"]')?.textContent).toContain('look like an address');
  expect((host!.querySelector('#ib-forgejo-origin') as HTMLInputElement).value).toBe('nope');
});
