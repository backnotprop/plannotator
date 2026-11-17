import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PANEL_TRANSITION_MS, usePanelPresence } from './usePanelPresence';

const hasDom = typeof document !== 'undefined';
const originalMatchMedia = hasDom ? window.matchMedia : undefined;
let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ open, animated = true }: { open: boolean; animated?: boolean }) {
  const panel = usePanelPresence(open, animated);
  return panel.present ? <section inert={panel.closing} aria-hidden={panel.closing || undefined}>
    <input defaultValue="Draft" />
  </section> : null;
}

async function mount(reduced = false) {
  window.matchMedia = ((media: string) => ({
    media, matches: reduced, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness open />));
  return host.querySelector('section')!;
}

async function finishExit() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, PANEL_TRANSITION_MS + 30)); });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
});

describe.if(hasDom)('panel exit presence', () => {
  test('retains the panel through exit, makes it inert, then removes it', async () => {
    const panel = await mount();
    await act(async () => root?.render(<Harness open={false} />));
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    await finishExit();
    expect(panel.isConnected).toBe(false);
  });

  test('reopening cancels removal and preserves the panel and its draft', async () => {
    const panel = await mount();
    panel.querySelector('input')!.value = 'Unsent comment';
    await act(async () => root?.render(<Harness open={false} />));
    await act(async () => root?.render(<Harness open />));
    await finishExit();
    expect(host!.querySelector('section')).toBe(panel);
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.querySelector('input')!.value).toBe('Unsent comment');
  });

  test('reduced motion removes the panel immediately', async () => {
    const panel = await mount(true);
    await act(async () => root?.render(<Harness open={false} />));
    expect(panel.isConnected).toBe(false);
  });

  test('leaving the animated layout removes an exiting panel immediately', async () => {
    const panel = await mount();
    await act(async () => root?.render(<Harness open={false} />));
    expect(panel.isConnected).toBe(true);
    await act(async () => root?.render(<Harness open={false} animated={false} />));
    expect(panel.isConnected).toBe(false);
  });
});
