/**
 * `N` / `Shift+N` in All files step through the changes of every expanded
 * file, in file order (#1543).
 *
 * CodeView is replaced by a stand-in that renders each item through the REAL
 * Pierre `FileDiff` (so the rows carry the `data-line-index` the jump reads)
 * and can leave items out of its rendered window, the way CodeView
 * virtualizes. happy-dom has no layout: a file starts FILE px below the
 * previous one, a row is ROW px, and the view is VIEW px tall. The stand-in's
 * `scrollTo({ type: 'line' })` centres the row it names, like CodeView's.
 *
 * Guards: a change in another file found by line number alone (the first
 * file's row with that number), the key missing files outside the rendered
 * window, collapsed files taking jumps, Shift being swallowed by the other
 * single-letter keys' modifier guard, and the key firing while typing.
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step (`--isolate`: this file mocks
 * '@pierre/diffs/react' and puts it back in afterAll).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

const ROW = 30;
const FILE = 3000;
let VIEW = 200;
let LEAD = 200;

let scrollTop = 0;
let lineScrolls: Array<{ id: string; lineNumber: number; side: string }> = [];
let notRendered = new Set<string>();
let collapsedIds = new Set<string>();

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

interface StandInItem {
  id: string;
  type: string;
  collapsed?: boolean;
  fileDiff?: Parameters<typeof realPierreDiffsReact.FileDiff>[0]['fileDiff'];
}

mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  CodeView: React.forwardRef(function StandInCodeView(
    props: { initialItems?: StandInItem[]; className?: string; containerRef?: React.Ref<HTMLDivElement> },
    ref: React.ForwardedRef<unknown>,
  ) {
    const items = props.initialItems ?? [];
    const wrappers = useRef(new Map<string, HTMLElement>());
    const container = useRef<HTMLDivElement | null>(null);
    useImperativeHandle(ref, () => ({
      getItem: (id: string) => {
        const item = items.find((candidate) => candidate.id === id);
        return item ? { ...item, collapsed: collapsedIds.has(id) } : undefined;
      },
      updateItem: () => true,
      scrollTo: (target: { type: string; id: string; lineNumber: number; side: string }) => {
        if (target.type !== 'line') return;
        lineScrolls.push({ id: target.id, lineNumber: target.lineNumber, side: target.side });
        const index = items.findIndex((item) => item.id === target.id);
        const row = findRow(wrappers.current.get(target.id), target.lineNumber, target.side);
        const unified = row ? Number.parseInt(row.getAttribute('data-line-index')!, 10) : 0;
        scrollTop = Math.max(0, LEAD + index * FILE + unified * ROW - VIEW / 2 + ROW / 2);
      },
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getContainerElement: () => container.current,
        getRenderedItems: () => items
          .filter((item) => !notRendered.has(item.id) && wrappers.current.has(item.id))
          .map((item) => ({ id: item.id, type: 'diff', item, element: wrappers.current.get(item.id)! })),
        getScrollTop: () => scrollTop,
        getTopForItem: (id: string) => LEAD + Math.max(0, items.findIndex((item) => item.id === id)) * FILE,
        getScrollHeight: () => LEAD + items.length * FILE,
        getHeight: () => VIEW,
        scrollTo: () => {},
      }),
    }));
    const setContainer = (el: HTMLDivElement | null) => {
      container.current = el;
      if (typeof props.containerRef === 'function') props.containerRef(el);
      else if (props.containerRef) (props.containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };
    return (
      <div ref={setContainer} className={props.className} data-standin-view="">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-file-offset={LEAD + index * FILE}
            ref={(el) => {
              if (el) wrappers.current.set(item.id, el);
            }}
          >
            {item.fileDiff ? (
              <realPierreDiffsReact.FileDiff fileDiff={item.fileDiff} options={{ diffStyle: 'unified' }} />
            ) : null}
          </div>
        ))}
      </div>
    );
  }),
  EditProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useStableCallback: <T extends (...args: never[]) => unknown>(callback: T): T => {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;
    return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
  },
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(_props, ref) {
    useImperativeHandle(ref, () => ({
      handleLineSelectionEnd: () => {},
      openLineAnnotation: () => {},
      handleTokenClick: () => {},
      startEdit: () => {},
    }));
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

function findRow(root: ParentNode | undefined, lineNumber: number, side: string): Element | null {
  if (!root) return null;
  const type = side === 'deletions' ? 'change-deletion' : 'change-addition';
  const visit = (node: ParentNode): Element | null => {
    const hit = node.querySelector(`[data-line="${lineNumber}"][data-line-type="${type}"]`);
    if (hit) return hit;
    for (const el of node.querySelectorAll('*')) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        const found = visit(shadow);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
}

/** The file wrapper a node sits in (crossing Pierre's shadow root). */
function fileOffsetOf(el: Element): number | null {
  let node: Node | null = el;
  while (node) {
    if (node instanceof HTMLElement && node.hasAttribute('data-file-offset')) {
      return Number(node.getAttribute('data-file-offset'));
    }
    const parent: Node | null = node.parentNode;
    node = parent ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    if (node === el) break;
  }
  return null;
}

const patch = (path: string, body: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ''].join('\n');

const FILES: DiffFile[] = [
  {
    path: 'a.ts',
    patch: patch('a.ts', ['@@ -1,3 +1,3 @@', ' a1', '-a2', '+A2', ' a3', '@@ -20,3 +20,3 @@', ' a20', '-a21', '+A21', ' a22']),
    additions: 2,
    deletions: 2,
    status: 'modified',
  },
  {
    path: 'b.ts',
    patch: patch('b.ts', ['@@ -1,3 +1,3 @@', ' b1', '-b2', '+B2', ' b3']),
    additions: 1,
    deletions: 1,
    status: 'modified',
  },
  {
    path: 'c.ts',
    patch: patch('c.ts', ['@@ -1,2 +1,3 @@', ' c1', '+c1b', ' c2']),
    additions: 1,
    deletions: 0,
    status: 'modified',
  },
];

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('AllFilesCodeView change navigation (DOM, real Pierre rows)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let originalRect: HTMLElement['getBoundingClientRect'];

  beforeEach(() => {
    VIEW = 200;
    LEAD = 200;
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    scrollTop = 0;
    lineScrolls = [];
    notRendered = new Set();
    collapsedIds = new Set();
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const rect = (top: number, height: number) =>
        ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} }) as DOMRect;
      const index = this.getAttribute('data-line-index');
      const offset = fileOffsetOf(this);
      if (index != null && offset != null) return rect(offset + Number.parseInt(index, 10) * ROW - scrollTop, ROW);
      if (this.hasAttribute('data-file-offset')) return rect(Number(this.getAttribute('data-file-offset')) - scrollTop, FILE);
      return rect(0, VIEW);
    };
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <AllFilesCodeView
          files={FILES}
          diffStyle="unified"
          annotations={[]}
          selectedAnnotationId={null}
          scrollTargetAnnotation={null}
          pendingSelection={null}
          isActive
          onLineSelection={() => {}}
          onAddAnnotationForFile={() => {}}
          onEditAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          onDeleteAnnotation={() => {}}
        />,
      );
    });
    for (let turn = 0; turn < 200 && countRows() < 4; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    // Precondition: the real parser gave every file its hunks, and Pierre painted them.
    expect(countRows()).toBeGreaterThanOrEqual(4);
  }

  function countRows(): number {
    let count = 0;
    const visit = (node: ParentNode) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.getAttribute('data-line-type')?.startsWith('change-') && el.closest('[data-gutter]') == null) count += 1;
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    if (host) visit(host);
    return count;
  }

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  const ids = () => lineScrolls.map((scroll) => `${scroll.id.includes('b.ts') ? 'b' : scroll.id.includes('c.ts') ? 'c' : 'a'}:${scroll.side[0]}${scroll.lineNumber}`);

  test('N walks the changes of every file in order, Shift+N walks back', async () => {
    await mount();
    expect(press('n').defaultPrevented).toBe(true);
    press('n');
    press('n');
    press('n');
    expect(ids()).toEqual(['a:d2', 'a:d21', 'b:d2', 'c:a2']);
    expect(scrollTop).toBe(LEAD + 2 * FILE + 1 * ROW - VIEW / 2 + ROW / 2);

    expect(press('n').defaultPrevented).toBe(false);
    expect(lineScrolls).toHaveLength(4);
    press('N', { shiftKey: true });
    press('N', { shiftKey: true });
    expect(ids().slice(4)).toEqual(['b:d2', 'a:d21']);
  });

  test('a tall view at the top with nothing above the files: the first N lands on the first change', async () => {
    LEAD = 0;
    VIEW = 830;
    await mount();
    press('n');
    press('n');
    expect(ids()).toEqual(['a:d2', 'a:d21']);
  });

  test('collapsed files are skipped; files outside the rendered window are reached', async () => {
    await mount();
    press('n');
    press('n');
    press('n');
    press('n');
    const bId = lineScrolls[2].id;
    const cId = lineScrolls[3].id;

    scrollTop = 0;
    lineScrolls = [];
    collapsedIds = new Set([bId]);
    notRendered = new Set([cId]);
    press('n');
    press('n');
    press('n');
    expect(ids()).toEqual(['a:d2', 'a:d21', 'c:a2']);
  });

  test('never while typing, with Mod or Alt, or for P', async () => {
    await mount();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    try {
      expect(press('n', {}, textarea).defaultPrevented).toBe(false);
      press('N', { shiftKey: true }, textarea);
      press('n', { metaKey: true });
      press('n', { altKey: true });
      press('p');
      expect(lineScrolls).toEqual([]);
    } finally {
      textarea.remove();
    }
  });
});
