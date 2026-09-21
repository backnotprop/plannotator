/**
 * Composer one-click "Looks good" (DOM_TESTS=1)
 *
 * The restored thumbs-up for comment-only surfaces: pinpoint clicks open the
 * composer directly (never the selection toolbar), so the composer carries a
 * footer "Looks good" action when the host passes onQuickLookGood. The button
 * must never discard a draft: once the user has typed, it disables and Save
 * becomes the path. Hosts that pass nothing render no button at all.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover } from './CommentPopover';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(props: { onQuickLookGood?: () => void }): Promise<void> {
  const anchor = document.createElement('p');
  anchor.textContent = 'pinpointed element text';
  document.body.appendChild(anchor);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CommentPopover
        anchorEl={anchor}
        contextText="pinpointed element text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        onQuickLookGood={props.onQuickLookGood}
      />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function looksGoodButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Looks good'),
    ) ?? null
  );
}

function composerTextarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!el) throw new Error('composer textarea did not render');
  return el;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.textContent = '';
});

describe.if(hasDom)('CommentPopover onQuickLookGood', () => {
  test('renders the footer button and a click fires the host callback', async () => {
    let fired = 0;
    await mount({ onQuickLookGood: () => fired++ });
    const btn = looksGoodButton();
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);
    await act(async () => btn!.click());
    expect(fired).toBe(1);
  });

  test('disables once the user has typed, so a click can never discard a draft', async () => {
    let fired = 0;
    await mount({ onQuickLookGood: () => fired++ });
    const textarea = composerTextarea();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, 'actually, one concern');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const btn = looksGoodButton();
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    await act(async () => btn!.click());
    expect(fired).toBe(0);
  });

  test('absent callback renders no button (markdown/global composers unchanged)', async () => {
    await mount({});
    expect(looksGoodButton()).toBeNull();
  });
});
