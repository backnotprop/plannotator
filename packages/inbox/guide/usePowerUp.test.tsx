/**
 * Power Up in an Inbox reader (usePowerUp.ts, PowerUpMark.tsx): asked only while code review's Power Up switch is on
 * (config.json `diffOptions.powerUp`, read on any address) and a key is set; the mark in the review's bar sums every
 * file's status, says why when the provider failed, and Retry asks again; a phone shows the face alone, whose press
 * opens the same words. The provider is never called: the settings read is a stand-in fetch.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { adoptSavedDiffOptions, resetInboxDiffOptionsForTests } from '../diffOptions';
import { usePowerUp, type InboxPowerUp } from './usePowerUp';
import { PowerUpMark } from './PowerUpMark';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const CLIENT = {} as SemDiffClient;

function keySet(configured: boolean) {
  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reads.push(String(input));
    return new Response(JSON.stringify({ configured, provider: configured ? 'custom' : null, ...(configured ? { endpoint: '127.0.0.1:4317' } : {}) }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return reads;
}

async function reader(compact = false): Promise<{ seen: InboxPowerUp[]; node: HTMLElement }> {
  const seen: InboxPowerUp[] = [];
  const node = document.createElement('div');
  document.body.appendChild(node);
  function Probe() {
    const power = usePowerUp(CLIENT);
    seen.push(power);
    return <PowerUpMark power={power} compact={compact} />;
  }
  const root = createRoot(node);
  roots.push(root);
  await act(async () => root.render(<Probe />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { seen, node };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  resetInboxDiffOptionsForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
});

test.skipIf(!hasDom)('with a key, the mark sums every file, says why a provider failed, and Retry asks again', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  const reads = keySet(true);
  const { seen, node } = await reader();
  const power = () => seen.at(-1)!;
  expect(reads).toEqual(['/api/sem-diff/opinion/settings']);
  expect(power().powerUp?.active).toBe(true);
  // Nothing shown until a file has said how it went.
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
  await act(async () => {
    power().reportFor('src/cart.ts')({ asking: 0, answered: 1, links: 1, unavailable: null });
    power().reportFor('src/tax.ts')({ asking: 0, answered: 1, links: 2, unavailable: null });
  });
  expect(node.querySelector('[data-power-up-status]')?.getAttribute('data-power-up-status')).toBe('powered');
  expect(node.textContent).toContain('Powered up · 3 links');
  await act(async () => power().reportFor('src/tax.ts')({ asking: 0, answered: 0, links: 0, unavailable: 'refusedKey' }));
  expect(node.textContent).toContain('Power Up: key refused');
  const retries = power().powerUp!.retry;
  const retry = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
  await act(async () => retry.click());
  expect(power().powerUp!.retry).toBe(retries + 1);
});

test.skipIf(!hasDom)('no key: nothing is asked and no mark is drawn', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(false);
  const { seen, node } = await reader();
  expect(seen.at(-1)!.powerUp).toBeNull();
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
});

test.skipIf(!hasDom)('a phone: the face alone in the bar; its press opens the same words', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(true);
  const { seen, node } = await reader(true);
  await act(async () => seen.at(-1)!.reportFor('src/cart.ts')({ asking: 0, answered: 1, links: 1, unavailable: null }));
  const face = node.querySelector<HTMLButtonElement>('button[data-power-up-slot]')!;
  expect(face.getAttribute('aria-label')).toBe('Powered up · 1 link');
  expect(node.querySelector('[data-power-up-card]')).toBeNull();
  expect(node.textContent).not.toContain('Powered up');
  await act(async () => face.click());
  expect(node.querySelector('[data-power-up-card]')?.textContent).toContain('Powered up · 1 link');
});

// Last: config.json's value, once adopted, stays this page's (the store's server value).
test.skipIf(!hasDom)('Power Up off in code review (config.json, on another address): the reader asks no provider and shows no mark', async () => {
  resetInboxDiffOptionsForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(true);
  // The first settings read: code review saved Power Up off; this address's cookie says nothing.
  adoptSavedDiffOptions({ power_up: false });
  const { seen, node } = await reader();
  await act(async () => seen.at(-1)!.reportFor('src/cart.ts')({ asking: 1, answered: 0, links: 0, unavailable: null }));
  expect(seen.every((power) => power.powerUp === null)).toBe(true);
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
});
