import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';

/**
 * The compact review shell renders a session-only unified diff, so the
 * Display tab's Split/Unified control had no effect there while still writing
 * the persisted DESKTOP preference. Hide it on compact and say what the phone
 * is doing; leave the desktop control exactly as it was.
 */

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

describe.if(hasDom)('review Display tab diff style', () => {
  test('desktop keeps the Split/Unified control', async () => {
    await openDisplayTab(false);

    const options = styleControlButtons();
    expect(options.map((button) => button.textContent?.trim()).sort()).toEqual(['Split', 'Unified']);
    expect(document.body.textContent).not.toContain('unified diffs for the session');
  });

  test('compact hides the control and explains the session behavior', async () => {
    await openDisplayTab(true);

    expect(styleControlButtons()).toHaveLength(0);
    expect(document.body.textContent).toContain('unified diffs for the session');
    // The rest of the tab is unaffected.
    expect(document.body.textContent).toContain('Diff Style');
  });
});
