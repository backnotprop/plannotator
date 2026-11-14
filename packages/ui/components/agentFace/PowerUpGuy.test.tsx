import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POWER_UP_GUY_REST_MS, PowerUpGuy, type PowerUpGuyState } from './PowerUpGuy';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function show(state: PowerUpGuyState, poke = 0) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<PowerUpGuy state={state} poke={poke} />));
  return host.querySelector<HTMLElement>('[data-power-up-guy]')!;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasDom)('PowerUpGuy', () => {
  test('grey is a still picture and never comes alive', async () => {
    const guy = await show('grey');
    expect(guy.dataset.powerUpGuy).toBe('grey');
    expect(guy.querySelector('img')?.style.filter).toContain('grayscale');
  });

  test('alive wakes, rests after the idle time, and wakes again on a poke', async () => {
    let guy = await show('alive');
    expect(guy.dataset.powerUpGuy).toBe('alive');
    await act(async () => wait(POWER_UP_GUY_REST_MS + 100));
    expect(guy.dataset.powerUpGuy).toBe('resting');
    expect(guy.querySelector('img')).not.toBeNull();
    guy = await show('alive', 1);
    expect(guy.dataset.powerUpGuy).toBe('alive');
  }, POWER_UP_GUY_REST_MS + 3000);

  test('a hidden tab puts him to rest', async () => {
    const guy = await show('alive');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(guy.dataset.powerUpGuy).toBe('resting');
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });
});
