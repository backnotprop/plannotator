import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchSummaryLine } from './LaunchPad';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('the launch row keeps the model name whole', () => {
  test('the engine is its mark with its name in the tooltip; the model and every option stay whole and wrap instead of being cut', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<LaunchSummaryLine summary="Claude · Sonnet 5.5 · High · Fast" engine="claude" />));
    const line = host.querySelector<HTMLElement>('[data-launch-summary]')!;
    const engine = host.querySelector<HTMLElement>('[data-launch-engine]')!;
    expect(engine.getAttribute('title')).toBe('Claude');
    expect(engine.textContent).toBe('');
    expect(engine.querySelector('svg, img')).not.toBeNull();
    expect(host.querySelector('[data-launch-model]')!.textContent).toBe('Sonnet 5.5');
    expect([...host.querySelectorAll('[data-launch-option]')].map((o) => o.textContent)).toEqual(['· High', '· Fast']);
    expect(line.className).toContain('flex-wrap');
    expect(host.querySelector('.truncate')).toBeNull();
    expect(line.getAttribute('title')).toBe('Claude · Sonnet 5.5 · High · Fast');
  });
});
