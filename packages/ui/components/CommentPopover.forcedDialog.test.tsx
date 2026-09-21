/**
 * Geometry-forced expanded composer (DOM_TESTS=1)
 *
 * On a fine-pointer viewport the composer normally opens as a popover and the
 * expanded dialog is a user choice, so Escape and the Collapse button take it
 * back. When the anchor has no room, the position tracker FORCES the dialog,
 * and collapsing recomputes the same geometry and immediately re-expands. That
 * made Escape a no-op and left the composer with no keyboard exit.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover } from './CommentPopover';

const hasDom = typeof document !== 'undefined';

// Fine pointer, and a viewport short enough that a mid-document anchor has
// under 280px of room on either side (the popover's minimum).
const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 560;
const CRAMPED_ANCHOR = { top: 280, bottom: 300, left: 400, right: 460, width: 60 };
const ROOMY_ANCHOR = { top: 40, bottom: 60, left: 400, right: 460, width: 60 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;
let originalWidth = 0;
let originalHeight = 0;

// SAFETY: implements the MediaQueryList surface the composer consumes; nothing
// matches, which is a fine-pointer desktop.
function fineMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function collapseButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[title="Collapse"]');
}

async function pressEscapeInComposer(): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('composer textarea did not render');
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
  });
}

beforeEach(() => {
  if (!hasDom) return;
  originalMatchMedia = window.matchMedia;
  originalWidth = window.innerWidth;
  originalHeight = window.innerHeight;
  window.matchMedia = fineMatchMedia as typeof window.matchMedia;
  setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    setViewport(originalWidth, originalHeight);
  }
});

describe.if(hasDom)('CommentPopover forced expansion', () => {
  test('a cramped anchor opens the dialog with no Collapse control', async () => {
    await mount(
      <CommentPopover
        anchorRect={CRAMPED_ANCHOR as DOMRect}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    expect(dialog()).not.toBeNull();
    expect(collapseButton()).toBeNull();
  });

  test('Escape closes a forced dialog instead of bouncing off the re-expand', async () => {
    let closes = 0;
    await mount(
      <CommentPopover
        anchorRect={CRAMPED_ANCHOR as DOMRect}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => { closes += 1; }}
      />,
    );
    expect(dialog()).not.toBeNull();

    await pressEscapeInComposer();
    expect(closes).toBe(1);
  });

  test('a user-expanded dialog still collapses on Escape and keeps its Collapse control', async () => {
    let closes = 0;
    await mount(
      <CommentPopover
        anchorRect={ROOMY_ANCHOR as DOMRect}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => { closes += 1; }}
      />,
    );
    // Roomy anchor: opens as a popover.
    expect(dialog()).toBeNull();

    const expand = document.querySelector<HTMLButtonElement>('button[title="Expand"]');
    if (!expand) throw new Error('popover did not render its Expand control');
    await act(async () => expand.click());
    expect(dialog()).not.toBeNull();
    expect(collapseButton()).not.toBeNull();

    await pressEscapeInComposer();
    expect(closes).toBe(0);
    expect(dialog()).toBeNull();
  });
});
