import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const toolbarModule = hasDom ? await import('./AnnotationToolbar') : null;
const AnnotationToolbar = toolbarModule?.AnnotationToolbar as typeof import('./AnnotationToolbar')['AnnotationToolbar'];

/** Laid-out height of the toolbar. happy-dom does no layout, so we stub the
 * height the component measures: the collapsed composer vs. the same toolbar
 * with the suggested-code section expanded. */
const COLLAPSED_TOOLBAR_HEIGHT = 236;
const EXPANDED_TOOLBAR_HEIGHT = 360;
let toolbarHeight = EXPANDED_TOOLBAR_HEIGHT;

const originalScrollHeight = hasDom
  ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  : undefined;

let host: HTMLElement | null = null;
let root: Root | null = null;
let toolbarRef: React.RefObject<HTMLDivElement | null> | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

function finePointerMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

beforeEach(() => {
  if (!hasDom) return;
  toolbarHeight = EXPANDED_TOOLBAR_HEIGHT;
  originalMatchMedia = window.matchMedia;
  window.matchMedia = finePointerMatchMedia;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('review-toolbar') ? toolbarHeight : 0;
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  toolbarRef = null;
  if (hasDom) {
    document.body.replaceChildren();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    } else {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  }
});

interface ToolbarOverrides {
  positionTop?: number;
  showSuggestedCode?: boolean;
}

async function renderToolbar(
  positionLeft: number,
  askAIMode: boolean,
  { positionTop = 100, showSuggestedCode = false }: ToolbarOverrides = {},
): Promise<HTMLElement> {
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        toolbarState={{
          position: { top: positionTop, left: positionLeft },
          range: { start: 6, end: 6, side: 'additions' },
        }}
        toolbarRef={toolbarRef!}
        commentText=""
        setCommentText={() => {}}
        suggestedCode=""
        setSuggestedCode={() => {}}
        showSuggestedCode={showSuggestedCode}
        setShowSuggestedCode={() => {}}
        askAIMode={askAIMode}
        setAskAIMode={() => {}}
        setShowCodeModal={() => {}}
        setShowCommentModal={() => {}}
        onSubmit={() => {}}
        onDismiss={() => {}}
        onCancel={() => {}}
        conventionalCommentsEnabled={false}
        conventionalLabel={null}
        onConventionalLabelChange={() => {}}
        decorations={[]}
        onDecorationsChange={() => {}}
      />,
    );
  });

  const toolbar = document.querySelector<HTMLElement>('.review-toolbar');
  if (!toolbar) throw new Error('review annotation toolbar did not render');
  return toolbar;
}

async function mountToolbar(
  positionLeft: number,
  askAIMode: boolean,
  overrides: ToolbarOverrides = {},
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  toolbarRef = React.createRef<HTMLDivElement>();
  return renderToolbar(positionLeft, askAIMode, overrides);
}

/** Simulates the pointer drag the toolbar header enables. */
async function dragToolbarTo(toolbar: HTMLElement, clientY: number): Promise<void> {
  const handle = toolbar.firstElementChild?.firstElementChild;
  if (!handle) throw new Error('annotation toolbar drag handle did not render');

  await act(async () => {
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 100 }),
    );
  });
  await act(async () => {
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY }),
    );
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
}

function toolbarHorizontalEdges(toolbar: HTMLElement): { left: number; right: number } {
  const width = Number.parseFloat(toolbar.style.width);
  const center = Number.parseFloat(toolbar.style.left);
  return { left: center - width / 2, right: center + width / 2 };
}

/** Vertical edges as laid out, from the committed top plus the stubbed height. */
function toolbarVerticalEdges(toolbar: HTMLElement): { top: number; bottom: number } {
  const top = Number.parseFloat(toolbar.style.top);
  return { top, bottom: top + toolbarHeight };
}

for (const [mode, askAIMode] of [['Comment', false], ['Ask AI', true]] as const) {
  describe(`${mode} toolbar placement`, () => {
    test.skipIf(!hasDom)('keeps the full toolbar inside the left viewport edge', async () => {
      const toolbar = await mountToolbar(0, askAIMode);
      expect(toolbarHorizontalEdges(toolbar).left).toBeGreaterThanOrEqual(0);
    });

    test.skipIf(!hasDom)('keeps the full toolbar inside the right viewport edge', async () => {
      const toolbar = await mountToolbar(window.innerWidth, askAIMode);
      expect(toolbarHorizontalEdges(toolbar).right).toBeLessThanOrEqual(window.innerWidth);
    });

    test.skipIf(!hasDom)(
      'flips above the anchor so an expanded compose row stays on screen',
      async () => {
        const anchorTop = window.innerHeight - 60;
        const toolbar = await mountToolbar(window.innerWidth / 2, askAIMode, {
          positionTop: anchorTop,
          showSuggestedCode: true,
        });

        const { top, bottom } = toolbarVerticalEdges(toolbar);
        expect(bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(top).toBeLessThan(anchorTop);
      },
    );

    test.skipIf(!hasDom)('sits at the anchor when the toolbar fits below it', async () => {
      const toolbar = await mountToolbar(window.innerWidth / 2, askAIMode, {
        positionTop: 120,
        showSuggestedCode: true,
      });

      expect(toolbarVerticalEdges(toolbar)).toEqual({
        top: 120,
        bottom: 120 + EXPANDED_TOOLBAR_HEIGHT,
      });
    });

    test.skipIf(!hasDom)('stays clamped to the visible top edge', async () => {
      const toolbar = await mountToolbar(window.innerWidth / 2, askAIMode, { positionTop: -200 });
      expect(toolbarVerticalEdges(toolbar).top).toBe(0);
    });

    test.skipIf(!hasDom)(
      'pins a toolbar taller than the viewport to the top and clamps its height',
      async () => {
        toolbarHeight = window.innerHeight + 200;
        const toolbar = await mountToolbar(window.innerWidth / 2, askAIMode, {
          positionTop: window.innerHeight - 40,
          showSuggestedCode: true,
        });

        expect(toolbarVerticalEdges(toolbar).top).toBe(0);
        expect(Number.parseFloat(toolbar.style.maxHeight)).toBe(window.innerHeight);
      },
    );
  });
}

describe('dragged toolbar placement', () => {
  test.skipIf(!hasDom)(
    'stays in bounds when the suggested-code section expands after a drag',
    async () => {
      toolbarHeight = COLLAPSED_TOOLBAR_HEIGHT;
      const toolbar = await mountToolbar(window.innerWidth / 2, false, { positionTop: 100 });

      // Drag the toolbar down to the bottom edge of the viewport; it clamps
      // flush against it rather than hanging off the edge.
      await dragToolbarTo(toolbar, window.innerHeight - 30);
      expect(toolbarVerticalEdges(toolbar)).toEqual({
        top: window.innerHeight - COLLAPSED_TOOLBAR_HEIGHT,
        bottom: window.innerHeight,
      });

      // Expanding the composer grows the box; it must slide back into bounds
      // instead of running off the bottom of the viewport.
      toolbarHeight = EXPANDED_TOOLBAR_HEIGHT;
      await renderToolbar(window.innerWidth / 2, false, { positionTop: 100, showSuggestedCode: true });

      expect(toolbarVerticalEdges(toolbar)).toEqual({
        top: window.innerHeight - EXPANDED_TOOLBAR_HEIGHT,
        bottom: window.innerHeight,
      });
    },
  );
});
