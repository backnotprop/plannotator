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
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `alpha-${String(i).padStart(2, '0')}`,
    root: 'claude' as const,
    humanOnly: false,
  })),
  { name: 'zebra', root: 'universal', humanOnly: true },
];

const ROW = 40;
const GAP = 6;
const MARGIN = 8;
const MAX_LIST = 256;

let root: Root | null = null;
let host: HTMLElement | null = null;
const originalInnerHeight = hasDom ? window.innerHeight : 0;

async function mountPopover(props: Partial<React.ComponentProps<typeof CommentPopover>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 300, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        skillReferences
        {...props}
      />,
    );
  });
  await act(async () => {});
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
  if (hasDom) {
    document.body.innerHTML = '';
    setInnerHeight(originalInnerHeight);
    resetSkillCatalogCache();
    resetSkillCatalogTransport();
  }
});

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

function menu(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-skill-menu]');
  if (!el) throw new Error('skill menu did not render');
  return el;
}

function list(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-skill-menu-list]');
  if (!el) throw new Error('skill menu list did not render');
  return el;
}

function clippingAncestor(el: HTMLElement): HTMLElement | null {
  let ancestor = el.parentElement;
  while (ancestor && ancestor !== document.body) {
    const style = window.getComputedStyle(ancestor);
    const clipsOverflow = [style.overflow, style.overflowX, style.overflowY]
      .some((value) => /^(auto|clip|hidden|scroll)$/.test(value));
    if (clipsOverflow) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
}

function makeRect(top: number, bottom: number): DOMRect {
  return {
    x: 100,
    y: top,
    top,
    bottom,
    left: 100,
    right: 460,
    width: 360,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value });
}

function stubGeometry(wrapper: { top: number; bottom: number }) {
  const wrapperEl = menu().parentElement as HTMLElement;
  wrapperEl.getBoundingClientRect = () => makeRect(wrapper.top, wrapper.bottom);
  const listEl = list();
  Object.defineProperty(listEl, 'scrollHeight', {
    configurable: true,
    get: () => listEl.querySelectorAll('[data-skill-item]').length * ROW,
  });
}

async function remeasure() {
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
}

function assertMenuInsideViewport(): { direction: string; maxListHeight: number } {
  const menuEl = menu();
  const listEl = list();
  const direction = menuEl.getAttribute('data-skill-menu-placement');
  if (direction !== 'above' && direction !== 'below') {
    throw new Error(`missing placement attribute: ${String(direction)}`);
  }
  const maxListHeight = parseFloat(listEl.style.maxHeight);
  expect(Number.isFinite(maxListHeight)).toBe(true);
  const natural = listEl.querySelectorAll('[data-skill-item]').length * ROW;
  const menuHeight = Math.min(natural, maxListHeight);
  const wrapperRect = (menuEl.parentElement as HTMLElement).getBoundingClientRect();
  const top = direction === 'above' ? wrapperRect.top - GAP - menuHeight : wrapperRect.bottom + GAP;
  const bottom = top + menuHeight;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  const available =
    direction === 'above'
      ? wrapperRect.top - GAP - MARGIN
      : window.innerHeight - wrapperRect.bottom - GAP - MARGIN;
  expect(maxListHeight).toBeLessThanOrEqual(Math.max(0, Math.min(MAX_LIST, Math.round(available))));
  return { direction, maxListHeight };
}

describe('SkillReferenceMenu adaptive placement', () => {
  test.skipIf(!hasDom)(
    'the menu escapes the comment card overflow instead of being clipped at its edge',
    async () => {
      await mountPopover();
      await type(textarea(), '$');
      expect(clippingAncestor(menu()) === null).toBe(true);
    },
  );

  test.skipIf(!hasDom)(
    'THE bug: composer near the top of the viewport opens the menu BELOW, on screen',
    async () => {
      setInnerHeight(768);
      await mountPopover({ anchorRect: new DOMRect(100, 10, 60, 20) });
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 40, bottom: 200 });
      await remeasure();
      const { direction, maxListHeight } = assertMenuInsideViewport();
      expect(direction).toBe('below');
      expect(maxListHeight).toBe(MAX_LIST);
    },
  );

  test.skipIf(!hasDom)('composer near the bottom keeps the menu above, on screen', async () => {
    setInnerHeight(768);
    await mountPopover();
    const el = textarea();
    await type(el, '$');
    stubGeometry({ top: 560, bottom: 750 });
    await remeasure();
    const { direction, maxListHeight } = assertMenuInsideViewport();
    expect(direction).toBe('above');
    expect(maxListHeight).toBe(MAX_LIST);
  });

  test.skipIf(!hasDom)(
    'when both directions fit, the menu prefers above (the shipped direction)',
    async () => {
      setInnerHeight(768);
      await mountPopover();
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 370, bottom: 470 });
      await remeasure();
      const { direction } = assertMenuInsideViewport();
      expect(direction).toBe('above');
    },
  );

  test.skipIf(!hasDom)(
    'a long list that fits neither side fully is clamped to the roomier side',
    async () => {
      setInnerHeight(400);
      await mountPopover();
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 150, bottom: 280 });
      await remeasure();
      const { direction, maxListHeight } = assertMenuInsideViewport();
      expect(direction).toBe('above');
      expect(maxListHeight).toBe(150 - GAP - MARGIN);
      expect(maxListHeight).toBeLessThan(MAX_LIST);
    },
  );

  test.skipIf(!hasDom)('a short list fits above even where the full cap would not', async () => {
    setInnerHeight(768);
    await mountPopover();
    const el = textarea();
    await type(el, '$zeb');
    expect(document.querySelectorAll('[data-skill-item]').length).toBe(1);
    stubGeometry({ top: 150, bottom: 280 });
    await remeasure();
    const { direction } = assertMenuInsideViewport();
    expect(direction).toBe('above');
  });

  test.skipIf(!hasDom)(
    'filtering the list (item count change) recomputes: a flipped-below menu returns above once it fits',
    async () => {
      setInnerHeight(768);
      await mountPopover();
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 150, bottom: 280 });
      await remeasure();
      expect(assertMenuInsideViewport().direction).toBe('below');
      await type(el, '$zeb');
      expect(document.querySelectorAll('[data-skill-item]').length).toBe(1);
      const { direction } = assertMenuInsideViewport();
      expect(direction).toBe('above');
    },
  );

  test.skipIf(!hasDom)('a keyboard-short viewport promotes the anchored composer to its bounded overlay', async () => {
    setInnerHeight(768);
    await mountPopover();
    const el = textarea();
    await type(el, '$');
    stubGeometry({ top: 150, bottom: 250 });
    await remeasure();
    expect(assertMenuInsideViewport().direction).toBe('below');
    setInnerHeight(320);
    await remeasure();
    await act(async () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));
    expect(document.querySelector('.pn-visible-viewport-overlay')).not.toBeNull();
    expect(document.querySelector('button[title="Collapse"]')).toBeNull();
  });

  test.skipIf(!hasDom)('a scroll recomputes placement (capture listener, like the popover)', async () => {
    setInnerHeight(768);
    await mountPopover();
    const el = textarea();
    await type(el, '$');
    stubGeometry({ top: 400, bottom: 500 });
    await remeasure();
    expect(assertMenuInsideViewport().direction).toBe('above');
    stubGeometry({ top: 30, bottom: 130 });
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    const { direction } = assertMenuInsideViewport();
    expect(direction).toBe('below');
  });

  test.skipIf(!hasDom)(
    'with the popover itself flipped above its anchor, the menu still places on screen',
    async () => {
      setInnerHeight(768);
      await mountPopover({ anchorRect: new DOMRect(100, 700, 60, 20) });
      const popoverEl = document.querySelector<HTMLElement>('[data-comment-popover]');
      expect(popoverEl?.style.transform).toContain('translateY(-100%)');
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 480, bottom: 690 });
      await remeasure();
      const { direction, maxListHeight } = assertMenuInsideViewport();
      expect(direction).toBe('above');
      expect(maxListHeight).toBe(MAX_LIST);
    },
  );

  test.skipIf(!hasDom)(
    'REGRESSION (hover jitter): hovering any row, human-only included, changes neither the menu markup nor its committed placement',
    async () => {
      setInnerHeight(768);
      await mountPopover();
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 560, bottom: 750 });
      await remeasure();
      const menuEl = menu();
      const before = menuEl.outerHTML;
      const placementBefore = assertMenuInsideViewport();
      for (const name of ['zebra', 'alpha-00']) {
        const row = document.querySelector(`[data-skill-item="${name}"]`)!;
        await act(async () => {
          row.dispatchEvent(new Event('pointermove', { bubbles: true }));
          row.dispatchEvent(new Event('pointerover', { bubbles: true }));
          row.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        });
        expect(menu().outerHTML).toBe(before);
        await remeasure();
        const placementAfter = assertMenuInsideViewport();
        expect(placementAfter.direction).toBe(placementBefore.direction);
        expect(placementAfter.maxListHeight).toBe(placementBefore.maxListHeight);
        expect(menu().outerHTML).toBe(before);
        await act(async () => {
          row.dispatchEvent(new Event('pointerout', { bubbles: true }));
          row.dispatchEvent(new Event('pointerleave', { bubbles: true }));
        });
        expect(menu().outerHTML).toBe(before);
      }
    },
  );

  test.skipIf(!hasDom)(
    'dragging the popover to the top edge flips an open menu below',
    async () => {
      setInnerHeight(768);
      await mountPopover();
      const el = textarea();
      await type(el, '$');
      stubGeometry({ top: 400, bottom: 500 });
      await remeasure();
      expect(assertMenuInsideViewport().direction).toBe('above');

      const popoverEl = document.querySelector<HTMLElement>('[data-comment-popover]')!;
      const header = popoverEl.querySelector<HTMLElement>('div[style*="grab"]');
      if (!header) throw new Error('drag handle did not render');
      await act(async () => {
        header.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 200,
            clientY: 410,
          }),
        );
      });
      stubGeometry({ top: 20, bottom: 120 });
      await act(async () => {
        document.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 30 }));
        document.dispatchEvent(new MouseEvent('pointerup', {}));
      });
      const { direction } = assertMenuInsideViewport();
      expect(direction).toBe('below');
    },
  );
});

describe('computeMenuPlacement with a reading that is not a number', () => {
  test.skipIf(!hasDom)('always yields a finite height', async () => {
    const { computeMenuPlacement } = await import('./SkillReferenceMenu');
    const nanBottom = computeMenuPlacement({ top: 300, bottom: 360 }, 2000, 2, Number.NaN, { boundaryTop: 0 });
    expect(Number.isFinite(nanBottom.maxListHeight)).toBe(true);
    const nanCap = computeMenuPlacement({ top: 300, bottom: 360 }, 2000, 2, 800, { boundaryTop: 0, maxListHeight: Number.NaN });
    expect(Number.isFinite(nanCap.maxListHeight)).toBe(true);
  });
});
