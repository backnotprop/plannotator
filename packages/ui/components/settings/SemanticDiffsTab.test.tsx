import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SemanticDiffsTab } from './SemanticDiffsTab';

const hasDom = typeof document !== 'undefined';
const KEY = 'tsk-never-shown-again';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
const realFetch = globalThis.fetch;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = realFetch;
});

function server() {
  let provider: string | null = null;
  const posts: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.provider === 'clef') return new Response(JSON.stringify({ ok: false, failure: 'noCredit', reason: 'The account has no credit left.' }));
      if (body.apiKey !== KEY) return new Response(JSON.stringify({ ok: false, failure: 'refused', reason: 'The key was refused.' }));
      provider = body.provider;
      return new Response(JSON.stringify({ ok: true, provider, ms: 182 }));
    }
    if (init?.method === 'DELETE') {
      provider = null;
      return Response.json({ ok: true });
    }
    return new Response(JSON.stringify({ configured: provider !== null, provider }));
  }) as typeof fetch;
  return posts;
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<SemanticDiffsTab />));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function type(label: string, value: string) {
  const input = host!.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Settings › Semantic diffs › Power Up', () => {
  test.skipIf(!hasDom)('off until a key works; a refused key says why; a kept key is never shown again', async () => {
    server();
    await mount();
    const powerUp = () => [...host!.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent?.includes('Power Up'))!;
    expect(powerUp().disabled).toBe(true);
    await type('TypeSafe API key', 'wrong');
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(host!.textContent).toContain('Jev refused this key');
    expect(host!.querySelector('input[aria-label="TypeSafe API key"]')!.getAttribute('aria-invalid')).toBe('true');
    await type('TypeSafe API key', KEY);
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(host!.textContent).toContain('Key works · 182 ms');
    expect(host!.querySelector('[data-power-up-key-save]')!.textContent).toBe('Saved');
    expect(host!.querySelector('[data-power-up-key-set]')).not.toBeNull();
    expect(host!.innerHTML).not.toContain(KEY);
    expect(powerUp().disabled).toBe(false);
    expect(host!.textContent).toContain('code is sent to Jev');
    const clef = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Clef')!;
    await act(async () => clef.click());
    expect(host!.textContent).toContain('Jev keeps powering up until a Clef token works.');
    expect(powerUp().getAttribute('aria-checked')).toBe('true');
  });

  test.skipIf(!hasDom)('Clef asks for both fields in one fixed box and says when the account has no credit', async () => {
    server();
    await mount();
    const clef = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Clef')!;
    await act(async () => clef.click());
    expect(host!.textContent).toContain('Workers AI');
    expect(host!.textContent).toContain('Account ID');
    await type('Cloudflare account ID', 'acct');
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(host!.querySelector('input[aria-label="Workers AI token"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(host!.querySelector('input[aria-label="Cloudflare account ID"]')!.getAttribute('aria-invalid')).toBeNull();
    await type('Workers AI token', 'tok');
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const token = host!.querySelector<HTMLInputElement>('input[aria-label="Workers AI token"]')!;
    expect(document.getElementById(token.getAttribute('aria-describedby')!)?.textContent).toBe('No credit left on this Clef account');
    expect(host!.querySelector('form')!.className).toContain('w-[340px]');
  });

  test.skipIf(!hasDom)('OpenAI Decisions uses a separate key and saves only on submit', async () => {
    const posts = server();
    await mount();
    await type('TypeSafe API key', 'a-different-provider-key');
    const openai = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'OpenAI Decisions')!;
    await act(async () => openai.click());
    const key = host!.querySelector<HTMLInputElement>('input[aria-label="OpenAI API key"]')!;
    expect(key.value).toBe('');
    await type('OpenAI API key', KEY);
    await act(async () => key.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: openai })));
    expect(posts).toEqual([]);
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(posts).toEqual([{ provider: 'openai', apiKey: KEY }]);
    expect(key.value).toBe('');
    expect(host!.textContent).toContain('code is sent to OpenAI Decisions');
    expect(host!.querySelector('[data-power-up-key-save]')?.textContent).toBe('Saved');
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-power-up-key-remove]')!.click());
    const powerUp = [...host!.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent?.includes('Power Up'))!;
    expect(powerUp.disabled).toBe(true);
  });
});
