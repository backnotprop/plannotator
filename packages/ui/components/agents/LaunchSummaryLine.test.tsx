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
  test('engine and options give way first; the model never shrinks; the whole line is in the title', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<LaunchSummaryLine summary="Claude · Sonnet 5.5 · High · Fast" />));
    const line = host.querySelector<HTMLElement>('[data-launch-summary]')!;
    const model = host.querySelector<HTMLElement>('[data-launch-model]')!;
    expect(model.textContent).toBe('Sonnet 5.5');
    expect(model.className).toContain('flex-none');
    expect(line.getAttribute('title')).toBe('Claude · Sonnet 5.5 · High · Fast');
    const others = [...line.children].filter((child) => child !== model);
    expect(others.every((child) => child.className.includes('shrink') && child.className.includes('truncate'))).toBe(true);
  });
});
