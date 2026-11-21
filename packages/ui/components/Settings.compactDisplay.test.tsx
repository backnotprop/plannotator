import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function openDisplayTab(isCompactTouchLayout: boolean): Promise<void> {
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
        isCompactTouchLayout={isCompactTouchLayout}
      />,
    );
  });

  const displayTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Editor');
  if (!displayTab) throw new Error('review display tab did not render');
  await act(async () => displayTab.click());
}

function styleControlButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => button.textContent?.trim() === 'Split' || button.textContent?.trim() === 'Unified');
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('review Editor tab diff display', () => {
  test('desktop points to the header button and the gear instead of repeating their rows', async () => {
    await openDisplayTab(false);

    expect(styleControlButtons()).toHaveLength(0);
    expect(document.querySelector('[data-settings-diff-display]')?.textContent).toContain('the gear above the diff');
    expect(document.body.textContent).not.toContain('Wrap long lines');
    expect(document.body.textContent).not.toContain('unified diffs for the session');
  });

  test('a phone has no gear, so the same options sit in Settings, with the session note and no Split/Unified', async () => {
    await openDisplayTab(true);

    expect(styleControlButtons()).toHaveLength(0);
    expect(document.body.textContent).toContain('unified diffs for the session');
    const wrap = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => b.textContent?.includes('Wrap long lines'));
    expect(wrap).toBeDefined();
  });
});
