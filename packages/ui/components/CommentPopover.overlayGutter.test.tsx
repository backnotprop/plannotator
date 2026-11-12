/**
 * The composer paints its glyphs with a mirror <div> over a transparent-text textarea; only the
 * caret comes from the textarea itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import {
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  setSkillCatalogTransport,
} from '../utils/skillCatalog';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';

const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

const catalog: SkillCatalogEntry[] = [
  { name: 'animate', root: 'claude', description: 'Motion design', humanOnly: false },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountPopover() {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        skillReferences
      />,
    );
  });
  await act(async () => {}); // flush the catalog fetch effect
}

beforeEach(() => {
  if (!hasDom) return;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => catalog);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-skill-ref-overlay]');
  if (!el) throw new Error('composer overlay did not render');
  return el;
}

function stubBox(el: HTMLTextAreaElement, scrollbar: number, border = 0): void {
  const width = 320;
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientWidth', {
    value: width - scrollbar - border * 2,
    configurable: true,
  });
  el.style.paddingRight = '4px'; // stands in for the composer's `px-1`
  if (border) el.style.border = `${border}px solid black`;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('composer overlay gutter', () => {
  test.skipIf(!hasDom)('mirrors a classic scrollbar onto the overlay padding', async () => {
    await mountPopover();
    const el = textarea();
    stubBox(el, 12);
    await type(el, 'a long enough comment to wrap');
    expect(overlay().style.paddingRight).toBe('16px');
  });

  test.skipIf(!hasDom)('counts borders as borders, never as scrollbar', async () => {
    await mountPopover();
    const el = textarea();
    stubBox(el, 12, 1); // offsetWidth - clientWidth === 14 here
    await type(el, 'a long enough comment to wrap');
    expect(overlay().style.paddingRight).toBe('16px');
  });

  test.skipIf(!hasDom)(
    'writes no inline style at all when the scrollbar takes no layout (macOS/touch)',
    async () => {
      await mountPopover();
      const el = textarea();
      stubBox(el, 0);
      await type(el, 'a long enough comment to wrap');
      await type(el, 'a long enough comment to wrap, and then some more of it');
      const ov = overlay();
      expect(ov.style.paddingRight).toBe('');
      expect(ov.getAttribute('style')).toBeNull();
    },
  );

  test.skipIf(!hasDom)('drops the gutter again when the scrollbar goes away', async () => {
    await mountPopover();
    const el = textarea();
    stubBox(el, 12);
    await type(el, 'a long enough comment to wrap');
    expect(overlay().style.paddingRight).toBe('16px');

    stubBox(el, 0);
    await type(el, 'short');
    expect(overlay().style.paddingRight).toBe('');
    expect(overlay().getAttribute('style')).toBeNull();
  });

  test.skipIf(!hasDom)(
    'a resize that adds the scrollbar re-syncs without a keystroke',
    async () => {
      const realRO = globalThis.ResizeObserver;
      const callbacks: ResizeObserverCallback[] = [];
      let disconnected = 0;
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          disconnected++;
        }
      }
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      try {
        await mountPopover();
        const el = textarea();
        stubBox(el, 0);
        await type(el, 'a long enough comment to wrap');
        expect(overlay().getAttribute('style')).toBeNull();

        stubBox(el, 12);
        expect(callbacks.length).toBeGreaterThan(0);
        await act(async () => {
          for (const cb of callbacks) {
            cb([] as unknown as ResizeObserverEntry[], null as unknown as ResizeObserver);
          }
        });
        expect(overlay().style.paddingRight).toBe('16px');

        await act(async () => {
          root!.unmount();
          root = null;
        });
        expect(disconnected).toBeGreaterThan(0);
      } finally {
        globalThis.ResizeObserver = realRO;
      }
    },
  );

  test.skipIf(!hasDom)('runs without a ResizeObserver at all', async () => {
    const realRO = globalThis.ResizeObserver;
    // Simulate an environment without the API.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      await mountPopover();
      const el = textarea();
      stubBox(el, 12);
      await type(el, 'a long enough comment to wrap');
      expect(overlay().style.paddingRight).toBe('16px');
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });
});
