import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('Settings Analysis tab', () => {
  test.skipIf(!hasDom)('shows the Call flow analysis layer toggle', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Settings
          taterMode={false}
          onTaterModeChange={() => {}}
          mode="review"
          externalOpen
        />,
      );
    });

    const analysisTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Analysis');
    await act(async () => analysisTab?.click());

    const switches = Array.from(document.querySelectorAll('[role="switch"]'));
    expect(switches.length).toBeGreaterThanOrEqual(1);
    // Deliberate label lock: this layer name is maintainer-frozen.
    expect(document.body.textContent).toContain('Call flow');
  });
});
