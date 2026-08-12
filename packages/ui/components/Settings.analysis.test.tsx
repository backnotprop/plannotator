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

describe('Settings review analysis disclosure', () => {
  test.skipIf(!hasDom)('renders the review-authored computed Call flow install size beside the toggle', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const disclosure = 'Installs a small runtime for this review (JavaScript and TypeScript + Bash, ~7 MB) in the background. Needs Node.js 22+; other languages install as reviews need them.';
    await act(async () => {
      root!.render(
        <Settings
          taterMode={false}
          onTaterModeChange={() => {}}
          mode="review"
          externalOpen
          callFlowEnableDescription={disclosure}
        />,
      );
    });

    const analysisTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Analysis');
    await act(async () => analysisTab?.click());
    expect(document.body.textContent).toContain(disclosure);
  });
});
