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
    const disclosure = 'Enabling prepares a small local analysis runtime with JavaScript and TypeScript + Bash support for this review (~7 MB total). If anything is missing, Plannotator installs it automatically in the background. Requires Node.js 22 or newer. Other language support installs automatically as reviews need it.';
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
