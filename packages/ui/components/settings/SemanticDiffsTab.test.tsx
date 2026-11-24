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

  test.skipIf(!hasDom)('env-configured systemone endpoint enables Power Up and hides key input and Remove', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          configured: true,
          provider: 'jev',
          source: 'env',
          endpoint: 'inference.baseten.co',
          model: 'decision-models/baseten-mammoth-27b-latest',
        }),
      )) as unknown as typeof fetch;
    await mount();
    const powerUp = [...host!.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent?.includes('Power Up'))!;
    expect(powerUp.disabled).toBe(false);
    expect(host!.textContent).toContain('inference.baseten.co · decision-models/baseten-mammoth-27b-latest');
    expect(host!.textContent).toContain('PLANNOTATOR_OPINION_API_KEY');
    expect(host!.textContent).toContain('code is sent to inference.baseten.co');
    expect(host!.querySelector('input')).toBeNull();
    expect(host!.querySelector('[data-power-up-key-remove]')).toBeNull();
  });

  test.skipIf(!hasDom)('custom endpoint without env key shows endpoint host in key form and error text', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false, failure: 'refused', reason: 'The key was refused.' }));
      }
      return new Response(
        JSON.stringify({
          configured: false,
          provider: null,
          endpoint: 'inference.baseten.co',
          model: 'decision-models/baseten-mammoth-27b-latest',
        }),
      );
    }) as unknown as typeof fetch;
    await mount();
    expect(host!.textContent).toContain('inference.baseten.co · decision-models/baseten-mammoth-27b-latest');
    expect(host!.textContent).toContain('Paste the key for inference.baseten.co');
    expect(host!.textContent).toContain('code is sent to inference.baseten.co');
    await type('API key', 'wrong');
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(host!.textContent).toContain('inference.baseten.co refused this key');
  });

  test.skipIf(!hasDom)('Custom provider saves URL, model, auth header, and key, hydrates saved metadata, and flags invalid URLs', async () => {
    const posts: unknown[] = [];
    let savedSettings: Record<string, unknown> = { configured: false, provider: null };
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        posts.push(body);
        if (!body.url.startsWith('https://')) {
          return new Response(JSON.stringify({ ok: false, failure: 'invalidUrl', reason: 'Enter an http or https endpoint URL.' }));
        }
        savedSettings = {
          configured: true,
          provider: 'custom',
          url: body.url,
          endpoint: new URL(body.url).host,
          model: body.model,
          auth: body.auth,
        };
        return new Response(JSON.stringify({ ok: true, provider: 'custom', ms: 145 }));
      }
      return new Response(JSON.stringify(savedSettings));
    }) as typeof fetch;

    await mount();
    const customRadio = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Custom')!;
    await act(async () => customRadio.click());
    await type('Custom endpoint URL', 'ftp://bad.example.com');
    await type('Custom API key', KEY);
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(host!.textContent).toContain('Enter an http or https endpoint URL');
    expect(host!.querySelector('input[aria-label="Custom endpoint URL"]')!.getAttribute('aria-invalid')).toBe('true');

    await type('Custom endpoint URL', 'https://inference.baseten.co/v1/systemone');
    await type('Custom model', 'decision-models/baseten-mammoth-27b-latest');
    const apiKeyRadio = [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Api-Key')!;
    await act(async () => apiKeyRadio.click());
    await type('Custom API key', KEY);
    await act(async () => host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(posts[1]).toEqual({
      provider: 'custom',
      url: 'https://inference.baseten.co/v1/systemone',
      model: 'decision-models/baseten-mammoth-27b-latest',
      auth: 'api-key',
      apiKey: KEY,
    });
    expect(host!.textContent).toContain('Key works · 145 ms');
    expect(host!.querySelector('[data-power-up-key-save]')!.textContent).toBe('Saved');
    expect(host!.querySelector('[data-power-up-key-remove]')).not.toBeNull();
    expect(host!.innerHTML).not.toContain(KEY);
    expect(host!.textContent).toContain('inference.baseten.co · decision-models/baseten-mammoth-27b-latest');
    expect(host!.textContent).toContain('code is sent to inference.baseten.co');

    // Remount to confirm saved non-secret metadata hydrates while key stays hidden.
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    await mount();
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom endpoint URL"]')!.value).toBe('https://inference.baseten.co/v1/systemone');
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom model"]')!.value).toBe('decision-models/baseten-mammoth-27b-latest');
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom API key"]')!.value).toBe('');
    expect(host!.querySelector('[data-power-up-key-save]')!.textContent).toBe('Saved');
    expect(host!.innerHTML).not.toContain(KEY);
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

  test.skipIf(!hasDom)('switching models drops what was typed but brings back the saved Custom endpoint', async () => {
    globalThis.fetch = (async () => Response.json({
      configured: true,
      provider: 'custom',
      url: 'https://decisions.example.com/v1/systemone',
      endpoint: 'decisions.example.com',
      model: 'house-model',
      auth: 'bearer',
    })) as unknown as typeof fetch;
    await mount();
    const radio = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!;
    await type('Custom endpoint URL', 'https://typed.example.com/v1');
    await type('Custom API key', 'typed-but-not-saved');
    await act(async () => radio('OpenAI Decisions').click());
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="OpenAI API key"]')!.value).toBe('');
    expect(host!.textContent).toContain('decisions.example.com keeps powering up until an OpenAI API key works.');
    await act(async () => radio('Custom').click());
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom endpoint URL"]')!.value).toBe('https://decisions.example.com/v1/systemone');
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom model"]')!.value).toBe('house-model');
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Custom API key"]')!.value).toBe('');
    expect(host!.querySelector('[data-power-up-key-save]')!.textContent).toBe('Saved');
  });
});
