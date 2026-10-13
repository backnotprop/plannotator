/**
 * DOM-gated tests (DOM_TESTS=1) for image previews in the all-files view
 * (#1598). Registered in .github/workflows/test.yml's "Run UI seam-contract +
 * DOM tests" step.
 *
 * The failure under guard: Pierre's CodeView sizes each item from
 * `itemMetrics` and never measures the custom header slot, and the Before/After
 * image preview renders inside that slot. Without telling Pierre the slot's
 * real height, an image card is modeled as a bare 33px header, so it leaves the
 * virtual window after ~33px of scroll and the code files below jump into its
 * place. The fix hands the measured header height to that item's own
 * VirtualizedFileDiff (`setMetrics`) and re-lays it out (`updateItem`).
 *
 * The real virtualizer cannot run under happy-dom (no layout), so these tests
 * drive the seam: the header slot's measured height must reach the item's
 * instance, only for image-preview items, and follow the card when it shrinks.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

let lastCodeViewProps: Record<string, unknown> | null = null;
const updatedItemIds: string[] = [];

const realPierreDiffs = { ...(await import('@pierre/diffs')) };
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
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

mock.module('@pierre/diffs', () => ({
  DEFAULT_CODE_VIEW_FILE_METRICS: realPierreDiffs.DEFAULT_CODE_VIEW_FILE_METRICS,
  getSingularPatch: (patch: string) => ({
    name: /diff --git a\/(\S+)/.exec(patch)?.[1] ?? 'file.ts',
    type: 'change',
    hunks: [],
    splitLineCount: 1,
    unifiedLineCount: 1,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  }),
  processFile: () => null,
}));

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Array<{ id: string }>; className?: string; containerRef?: React.Ref<HTMLDivElement> },
    ref: React.ForwardedRef<unknown>,
  ) {
    const itemsRef = useRef(new Map((props.initialItems ?? []).map((item) => [item.id, item])));
    lastCodeViewProps = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => itemsRef.current.get(id),
      updateItem: (item: { id: string }) => {
        updatedItemIds.push(item.id);
        itemsRef.current.set(item.id, item);
        return true;
      },
      updateItemId: () => true,
      scrollTo: () => {},
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => [],
        getScrollTop: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        getTopForItem: () => 0,
        scrollTo: () => {},
      }),
    }));
    return <div ref={props.containerRef} className={props.className} />;
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

const hasDom = typeof document !== 'undefined';

// --- Layout stand-ins (happy-dom has no layout) ------------------------------

/** Height the "browser" reports for a header slot that holds a preview. */
let previewHeaderHeight = 0;
const HEADER_HEIGHT = 33; // PANEL_HEADER_HEIGHT

const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  fire() {
    if (this.targets.size === 0) return;
    const entries = [...this.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() }));
    this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}
const resizeAll = () => {
  for (const observer of [...observers]) observer.fire();
};

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;

function installLayout() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const height = this.querySelector('[data-test-preview]') ? previewHeaderHeight : HEADER_HEIGHT;
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON() {} } as DOMRect;
  };
}

// --- Fixtures ------------------------------------------------------------------

const imageFile: DiffFile = {
  path: 'public/icon.png',
  patch: 'diff --git a/public/icon.png b/public/icon.png\nindex 1111111..2222222 100644\nBinary files a/public/icon.png and b/public/icon.png differ',
  additions: 0,
  deletions: 0,
  status: 'modified',
};
const codeFile: DiffFile = {
  path: 'src/app.ts',
  patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 1,
  status: 'modified',
};

const renderImagePreview = () => <div data-test-preview="" />;

type Props = Partial<React.ComponentProps<typeof AllFilesCodeView>>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let headerRoot: Root | null = null;
let headerHost: HTMLElement | null = null;

async function render(overrides: Props = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AllFilesCodeView
        files={[imageFile, codeFile]}
        diffStyle="split"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        {...overrides}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

type SeededItem = { id: string; collapsed?: boolean };
const seededItem = (id: string) =>
  ((lastCodeViewProps?.initialItems ?? []) as SeededItem[]).find((item) => item.id === id)!;

/** Mount one item's custom header the way CodeView's header slot would. */
async function mountHeader(id: string, item: SeededItem = seededItem(id)) {
  const renderCustomHeader = lastCodeViewProps?.renderCustomHeader as (item: SeededItem) => React.ReactNode;
  if (!headerHost) {
    headerHost = document.createElement('div');
    document.body.appendChild(headerHost);
    headerRoot = createRoot(headerHost);
  }
  await act(async () => {
    headerRoot!.render(<>{renderCustomHeader(item)}</>);
  });
}

/** Fire CodeView's onPostRender for an item with a stand-in instance. */
function postRender(id: string, instance = { setMetrics: mock((_metrics?: Record<string, unknown>) => {}) }) {
  const options = lastCodeViewProps?.options as {
    onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: { item: SeededItem }) => void;
  };
  act(() => {
    options.onPostRender(document.createElement('div'), instance, 'mount', { item: seededItem(id) });
  });
  return instance;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  if (headerRoot) await act(async () => headerRoot?.unmount());
  host?.remove();
  headerHost?.remove();
  root = headerRoot = null;
  host = headerHost = null;
  lastCodeViewProps = null;
  updatedItemIds.length = 0;
  observers.clear();
  previewHeaderHeight = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  if (originalRect) HTMLElement.prototype.getBoundingClientRect = originalRect;
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('all-files image previews keep their real height in the virtual list (#1598)', () => {
  test("an image card's measured header height reaches its item's metrics and re-lays it out", async () => {
    installLayout();
    previewHeaderHeight = 420;
    await render({ renderImagePreview });

    await mountHeader(imageFile.path);
    const instance = postRender(imageFile.path);
    const { setMetrics } = instance;

    expect(setMetrics).toHaveBeenCalledTimes(1);
    expect(setMetrics.mock.calls[0][0]?.diffHeaderHeight).toBe(420);
    // The rest of the item's metrics stay the shared ones.
    expect(setMetrics.mock.calls[0][0]?.hunkSeparatorHeight).toBe(32);
    expect(updatedItemIds).toContain(imageFile.path);

    // The re-layout renders the item again; with nothing changed that render
    // must not re-apply, or every render would trigger another one.
    updatedItemIds.length = 0;
    postRender(imageFile.path, instance);
    expect(setMetrics).toHaveBeenCalledTimes(1);
    expect(updatedItemIds).toEqual([]);
  });

  test('the card growing after its images load, and collapsing to a bare header, both re-size the item', async () => {
    installLayout();
    previewHeaderHeight = 233; // loading placeholder
    await render({ renderImagePreview });
    await mountHeader(imageFile.path);
    const { setMetrics } = postRender(imageFile.path);
    expect(setMetrics.mock.calls.at(-1)?.[0]?.diffHeaderHeight).toBe(233);

    previewHeaderHeight = 391; // images decoded
    act(() => resizeAll());
    expect(setMetrics.mock.calls.at(-1)?.[0]?.diffHeaderHeight).toBe(391);

    // Collapsing removes the preview: the item must go back to the shared
    // header height rather than keep a 391px hole.
    await mountHeader(imageFile.path, { ...seededItem(imageFile.path), collapsed: true });
    act(() => resizeAll());
    expect(setMetrics.mock.calls.at(-1)?.[0]?.diffHeaderHeight).toBe(HEADER_HEIGHT);
  });

  test('a hidden panel (0px) keeps the last measured height instead of collapsing the card', async () => {
    installLayout();
    previewHeaderHeight = 400;
    await render({ renderImagePreview });
    await mountHeader(imageFile.path);
    const { setMetrics } = postRender(imageFile.path);
    expect(setMetrics).toHaveBeenCalledTimes(1);

    previewHeaderHeight = 0;
    act(() => resizeAll());
    expect(setMetrics).toHaveBeenCalledTimes(1);
  });

  test('code files and hosts without image previews (guide chain, guides.show) never get a per-item override', async () => {
    installLayout();
    previewHeaderHeight = 420;
    await render({ renderImagePreview });
    await mountHeader(codeFile.path);
    expect(postRender(codeFile.path).setMetrics).not.toHaveBeenCalled();

    if (root) await act(async () => root?.unmount());
    host?.remove();
    await render(); // no renderImagePreview
    await mountHeader(imageFile.path);
    expect(postRender(imageFile.path).setMetrics).not.toHaveBeenCalled();
  });
});
