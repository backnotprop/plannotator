/**
 * Adaptive placement for the skill-reference menu, against the REAL
 * CommentPopover.
 *
 * The bug this file pins down: the menu used to render `bottom-full` with a
 * fixed `max-h-64`, i.e. ALWAYS upward, up to 256px, with no viewport
 * awareness. Annotate near the top of the document, type `$`, and the menu
 * ran off the top of the screen with its upper rows unreachable (nothing
 * clips a z-[110] child of a fixed z-[100] popover).
 *
 * The rule now: measure the space above and below the composer wrapper the
 * way CommentPopover's own computePosition measures the anchor, PREFER above
 * (the shipped direction; keeps the action row and human-only notice
 * visible), flip below when the list fits below but not above, and when
 * neither side fits pick the roomier side and clamp the list height to it.
 * The menu must never extend past a viewport edge.
 *
 * happy-dom does no layout, so each test stubs the wrapper rect and the
 * list's scrollHeight, then derives the menu's on-screen rect from the
 * placement the component committed (direction attribute + clamped
 * max-height) exactly as the CSS would resolve it: `bottom-full mb-1.5`
 * places the menu's bottom 6px above the wrapper's top; `top-full mt-1.5`
 * places its top 6px below the wrapper's bottom.
 *
 * DOM-gated (DOM_TESTS=1), same harness as CommentPopover.skillReferences.
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

// 12 filterable entries: `$` shows all 12 (natural height 480 under the 40px
// row stub, so the 256px cap engages), `$zeb` narrows to exactly one. `zebra`
// is human-only: the menu must render (and place) it exactly like the rest.
const catalog: SkillCatalogEntry[] = [
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `alpha-${String(i).padStart(2, '0')}`,
    root: 'claude' as const,
    humanOnly: false,
  })),
  { name: 'zebra', root: 'universal', humanOnly: true },
];

/** Stubbed per-row height. Layout does not exist in happy-dom; the component
 * only ever reads the total via scrollHeight, which we derive from this. */
const ROW = 40;
/** Menu gap (mb-1.5 / mt-1.5) — must match MENU_GAP in SkillReferenceMenu. */
const GAP = 6;
/** Viewport margin — must match MENU_VIEWPORT_MARGIN in SkillReferenceMenu. */
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

/**
 * Stub the geometry the component measures: the composer wrapper's viewport
 * rect and the list's natural content height (rows currently in the DOM, so
 * filtering shrinks it the way real layout would).
 */
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

/**
 * Derive the menu's on-screen rect from the committed placement, as the CSS
 * would resolve it, and assert it lies fully inside the viewport.
 */
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
  const menuHeight = Math.min(natural, maxListHeight); // chrome is 0 in happy-dom
  const wrapperRect = (menuEl.parentElement as HTMLElement).getBoundingClientRect();
  const top = direction === 'above' ? wrapperRect.top - GAP - menuHeight : wrapperRect.bottom + GAP;
  const bottom = top + menuHeight;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  // The clamp itself must respect the margin, independent of natural height.
  const available =
    direction === 'above'
      ? wrapperRect.top - GAP - MARGIN
      : window.innerHeight - wrapperRect.bottom - GAP - MARGIN;
  expect(maxListHeight).toBeLessThanOrEqual(Math.max(0, Math.min(MAX_LIST, Math.round(available))));
  return { direction, maxListHeight };
}

describe('SkillReferenceMenu adaptive placement', () => {
  test.skipIf(!hasDom)(
    'THE bug: composer near the top of the viewport opens the menu BELOW, on screen',
    async () => {
      setInnerHeight(768);
      await mountPopover({ anchorRect: new DOMRect(100, 10, 60, 20) });
      const el = textarea();
      await type(el, '$');
      // Popover near the top: ~26px above the wrapper, plenty below.
      stubGeometry({ top: 40, bottom: 200 });
      await remeasure();
      const { direction, maxListHeight } = assertMenuInsideViewport();
      expect(direction).toBe('below');
      expect(maxListHeight).toBe(MAX_LIST); // full cap fits below
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
      // 370px above, ~280px below the wrapper: both fit the 256px cap.
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
      await type(el, '$'); // 12 rows, natural 480 > any side
      stubGeometry({ top: 150, bottom: 280 });
      await remeasure();
      const { direction, maxListHeight } = assertMenuInsideViewport();
      // 136px above vs 106px below: above is roomier, clamped to it.
      expect(direction).toBe('above');
      expect(maxListHeight).toBe(150 - GAP - MARGIN);
      expect(maxListHeight).toBeLessThan(MAX_LIST);
    },
  );

  test.skipIf(!hasDom)('a short list fits above even where the full cap would not', async () => {
    setInnerHeight(768);
    await mountPopover();
    const el = textarea();
    await type(el, '$zeb'); // exactly one row: natural 40
    expect(document.querySelectorAll('[data-skill-item]').length).toBe(1);
    // 136px above: too small for the 256 cap, ample for one 40px row.
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
      // 136px above: the 12-row list cannot fit above but fits below.
      stubGeometry({ top: 150, bottom: 280 });
      await remeasure();
      expect(assertMenuInsideViewport().direction).toBe('below');
      // Narrow to one row; no window event fires, the re-render recomputes.
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
    expect(assertMenuInsideViewport().direction).toBe('below'); // 504px below fits the cap
    // Below the shared 420px keyboard threshold, the entire anchored composer
    // yields to its existing expanded overlay instead of preserving a tiny,
    // menu-clamped popover.
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
    // The document scrolls; the tracked popover follows its anchor to the top.
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
      // Anchor near the viewport bottom: spaceBelow < 280 flips the popover.
      await mountPopover({ anchorRect: new DOMRect(100, 700, 60, 20) });
      const popoverEl = document.querySelector<HTMLElement>('[data-comment-popover]');
      expect(popoverEl?.style.transform).toContain('translateY(-100%)');
      const el = textarea();
      await type(el, '$');
      // The flipped popover sits above the anchor; its composer wrapper ends
      // near the bottom of the viewport with ample space above.
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
      // The bug this pins down: hovering a human-only row used to disclose a
      // warning footer, growing the bottom-anchored menu upward and shrinking
      // the re-measured list clamp — the hovered row shifted out from under
      // the pointer, hover ended, the footer collapsed, the row shifted back,
      // and the cycle repeated every frame. Hover must not change any row's
      // rendered output or the placement the component commits.
      setInnerHeight(768);
      await mountPopover();
      const el = textarea();
      await type(el, '$'); // all 12 rows, zebra (human-only) among them
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
        // Byte-identical markup: no class flip, no disclosed footer, no style
        // change — nothing for the placement effect to re-measure differently.
        expect(menu().outerHTML).toBe(before);
        // And a forced re-measure with the pointer "resting" on the row still
        // commits the same placement.
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

      // Drag by the header: pointerdown on the handle, then document-level
      // pointermove past the 3px threshold, then pointerup (useDraggable).
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
      // The popover lands near the top edge; the wrapper rect follows it.
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
