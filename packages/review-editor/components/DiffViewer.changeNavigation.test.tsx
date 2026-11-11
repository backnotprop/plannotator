/**
 * `N` / `Shift+N` step through the changes of the open file (#1543).
 *
 * Rendered with the REAL @pierre/diffs, because the jump finds a change's
 * first row by the `data-line-index` Pierre writes, and a mocked renderer
 * would only agree with the code that reads it. happy-dom has no layout, so
 * each row is placed by its unified index (ROW px a row) and the scroll
 * position is held by a stub: the viewport is VIEW px tall at the top of the
 * page.
 *
 * Guards: the first N at the top skipping changes already on screen, the
 * jump landing on the wrong change (or on a whole `@@` hunk
 * instead of each change inside it), stepping back from the last change,
 * a full-content (expanded) diff numbering its rows differently, the key
 * firing while typing or with a modifier, `P` (the Markdown view key) moving
 * the diff, and a diff that is not the active panel taking the key.
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run diff-renderer DOM tests (isolated, real @pierre/diffs)" step.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

const OLD_LINES = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const NEW_LINES = OLD_LINES.flatMap((line, i) => {
  if (i + 1 === 5) return ['const line5 = 500;'];
  if (i + 1 === 12) return ['const line12 = 1200;', 'const line12b = 12;'];
  if (i + 1 === 31) return [];
  return [line];
});
const OLD_CONTENTS = `${OLD_LINES.join('\n')}\n`;
const NEW_CONTENTS = `${NEW_LINES.join('\n')}\n`;

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 282a582..8975549 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -2,14 +2,15 @@ const line1 = 1;',
  ' const line2 = 2;',
  ' const line3 = 3;',
  ' const line4 = 4;',
  '-const line5 = 5;',
  '+const line5 = 500;',
  ' const line6 = 6;',
  ' const line7 = 7;',
  ' const line8 = 8;',
  ' const line9 = 9;',
  ' const line10 = 10;',
  ' const line11 = 11;',
  '-const line12 = 12;',
  '+const line12 = 1200;',
  '+const line12b = 12;',
  ' const line13 = 13;',
  ' const line14 = 14;',
  ' const line15 = 15;',
  '@@ -28,7 +29,6 @@ const line27 = 27;',
  ' const line28 = 28;',
  ' const line29 = 29;',
  ' const line30 = 30;',
  '-const line31 = 31;',
  ' const line32 = 32;',
  ' const line33 = 33;',
  ' const line34 = 34;',
  '',
].join('\n');

const ROW = 30;
const VIEW = 200;
let viewHeight = VIEW;

const centered = (unifiedIndex: number) => unifiedIndex * ROW - viewHeight / 2 + ROW / 2;

const FIRST = 4;
const SECOND = 12;
const THIRD = 33;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.if(hasDom)('DiffViewer change navigation (DOM, real Pierre)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let scrollTop = 0;
  let scrolls: number[] = [];
  const originalFetch = globalThis.fetch;
  let originalRect: HTMLElement['getBoundingClientRect'];
  let originalScrollTo: HTMLElement['scrollTo'];

  beforeEach(() => {
    viewHeight = VIEW;
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    originalScrollTo = HTMLElement.prototype.scrollTo;
    scrollTop = 0;
    scrolls = [];
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const index = this.getAttribute('data-line-index');
      if (index != null) {
        const top = Number.parseInt(index, 10) * ROW - scrollTop;
        return { top, bottom: top + ROW, height: ROW, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} } as DOMRect;
      }
      return { top: 0, bottom: viewHeight, height: viewHeight, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === 'object' && options && typeof options.top === 'number') {
        scrolls.push(options.top);
        scrollTop = options.top;
      }
    } as typeof HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: () => {},
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 40 * ROW + viewHeight });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewHeight });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    HTMLElement.prototype.scrollTo = originalScrollTo;
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  async function mount({ fullContents, changeNavigation = true }: { fullContents: boolean; changeNavigation?: boolean }) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/file-content') && fullContents
        ? { oldContent: OLD_CONTENTS, newContent: NEW_CONTENTS }
        : { oldContent: null, newContent: null };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <DiffViewer
          patch={PATCH}
          filePath="calc.ts"
          diffStyle="unified"
          annotations={[]}
          selectedAnnotationId={null}
          scrollTargetAnnotation={null}
          pendingSelection={null}
          isFocused
          changeNavigation={changeNavigation}
          onLineSelection={() => {}}
          onAddAnnotation={() => {}}
          onAddFileComment={() => {}}
          onEditAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          onDeleteAnnotation={() => {}}
        />,
      );
    });
    for (let turn = 0; turn < 400; turn += 1) {
      const rows = findRows(host);
      if (rows.has(THIRD) && (!fullContents || hasExpandButtons(host))) break;
      await act(async () => {
        await sleep(25);
      });
    }
    expect(findRows(host).has(THIRD)).toBe(true);
    expect(hasExpandButtons(host)).toBe(fullContents);
    scrolls = [];
  }

  function findRows(container: HTMLElement): Set<number> {
    const rows = new Set<number>();
    const visit = (node: ParentNode) => {
      for (const el of node.querySelectorAll('*')) {
        const index = el.getAttribute('data-line-index');
        if (index != null && el.getAttribute('data-line-type')?.startsWith('change-')) {
          rows.add(Number.parseInt(index, 10));
        }
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    visit(container);
    return rows;
  }

  function hasExpandButtons(container: HTMLElement): boolean {
    let found = false;
    const visit = (node: ParentNode) => {
      if (node.querySelector('[data-expand-button]')) found = true;
      for (const el of node.querySelectorAll('*')) {
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    visit(container);
    return found;
  }

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  for (const fullContents of [false, true]) {
    test(`N walks every change, then Shift+N walks back (${fullContents ? 'full file context' : 'patch only'})`, async () => {
      await mount({ fullContents });
      // The changes Pierre painted are the ones the jump targets: two inside
      // the first hunk, one in the second.
      expect([...findRows(host!)].filter((u) => u === FIRST || u === SECOND || u === THIRD).sort((a, b) => a - b))
        .toEqual([FIRST, SECOND, THIRD]);

      expect(press('n').defaultPrevented).toBe(true);
      press('n');
      press('n');
      expect(scrolls).toEqual([centered(FIRST), centered(SECOND), centered(THIRD)]);

      expect(press('n').defaultPrevented).toBe(false);
      expect(scrolls).toHaveLength(3);

      press('N', { shiftKey: true });
      press('N', { shiftKey: true });
      expect(scrolls.slice(3)).toEqual([centered(SECOND), Math.max(0, centered(FIRST))]);
      expect(press('N', { shiftKey: true }).defaultPrevented).toBe(false);
      expect(scrolls).toHaveLength(5);
    });
  }

  test('a tall view at the top: the first N lands on the first change, even on screen', async () => {
    viewHeight = 830;
    await mount({ fullContents: false });
    expect(press('n').defaultPrevented).toBe(true);
    expect(scrolls).toEqual([0]);
    press('n');
    press('n');
    expect(scrolls).toEqual([0, 0, centered(THIRD)]);
  });

  test('at the bottom, the first Shift+N lands on the last change', async () => {
    viewHeight = 830;
    await mount({ fullContents: false });
    scrollTop = 40 * ROW;
    press('N', { shiftKey: true });
    expect(scrolls).toEqual([centered(THIRD)]);
  });

  test('after scrolling by hand, N and Shift+N step from the middle of the view', async () => {
    await mount({ fullContents: false });
    scrollTop = 600;
    press('n');
    expect(scrolls).toEqual([centered(THIRD)]);
    scrollTop = 600;
    press('N', { shiftKey: true });
    expect(scrolls).toEqual([centered(THIRD), centered(SECOND)]);
  });

  test('never while typing, with a modifier, for P, or when the panel is not active', async () => {
    await mount({ fullContents: false });
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    try {
      expect(press('n', {}, textarea).defaultPrevented).toBe(false);
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      document.body.appendChild(editable);
      press('n', {}, editable);
      editable.remove();
      press('n', { metaKey: true });
      press('n', { ctrlKey: true });
      press('n', { altKey: true });
      press('p');
      press('P', { shiftKey: true });
      expect(scrolls).toEqual([]);
    } finally {
      textarea.remove();
    }

    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    await mount({ fullContents: false, changeNavigation: false });
    expect(press('n').defaultPrevented).toBe(false);
    expect(scrolls).toEqual([]);
  });
});
