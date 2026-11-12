import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

let lastCodeViewProps: Record<string, unknown> | null = null;
let renderedItems: Array<{ id: string; element: HTMLElement }> = [];
let viewport: HTMLElement | undefined;
let fakeEditingItemId: string | null = null;
const scrolls: string[] = [];
const updatedItems: Array<{ id: string; fileDiff: { hunks: unknown[]; cacheKey?: string } }> = [];

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
    hunks: patch.includes('@@') ? [{ stand: 'in' }] : [],
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
      updateItem: (item: { id: string; fileDiff: { hunks: unknown[]; cacheKey?: string } }) => {
        updatedItems.push({ id: item.id, fileDiff: item.fileDiff });
        itemsRef.current.set(item.id, item);
        return true;
      },
      updateItemId: () => true,
      scrollTo: (target: { id?: string }) => { scrolls.push(target.id ?? ''); },
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => renderedItems,
        getContainerElement: () => viewport,
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

mock.module('../edit/useEditSession', () => ({
  useEditSession: () => new Proxy({
    editingItemId: fakeEditingItemId,
    editingItemIdRef: { current: fakeEditingItemId },
    editUnavailableRef: { current: new Map() },
    dirtyStore: { subscribe: () => () => {}, getSnapshot: () => 0 },
    createEditor: undefined,
  } as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => {}),
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';

const mdFile: DiffFile = {
  path: 'docs/guide.md',
  patch: 'diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-# Old\n+# New',
  additions: 1,
  deletions: 1,
  status: 'modified',
};
const codeFile: DiffFile = {
  path: 'src/app.ts',
  patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 1,
  status: 'modified',
};

type Props = Partial<React.ComponentProps<typeof AllFilesCodeView>>;
type SeededItem = { id: string; collapsed?: boolean; fileDiff: { hunks: unknown[]; cacheKey?: string } };

let root: Root | null = null;
let host: HTMLElement | null = null;
let headerRoot: Root | null = null;
let headerHost: HTMLElement | null = null;

function viewProps(overrides: Props): React.ComponentProps<typeof AllFilesCodeView> {
  return {
    files: [mdFile, codeFile],
    diffStyle: 'split',
    annotations: [],
    selectedAnnotationId: null,
    scrollTargetAnnotation: null,
    pendingSelection: null,
    onLineSelection: () => {},
    onAddAnnotationForFile: () => {},
    onEditAnnotation: () => {},
    onSelectAnnotation: () => {},
    onDeleteAnnotation: () => {},
    isActive: true,
    ...overrides,
  };
}

async function render(overrides: Props = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<AllFilesCodeView {...viewProps(overrides)} />);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

async function rerender(overrides: Props) {
  await act(async () => {
    root!.render(<AllFilesCodeView {...viewProps(overrides)} />);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

const seededItem = (id: string) =>
  ((lastCodeViewProps?.initialItems ?? []) as SeededItem[]).find((item) => item.id === id)!;

async function mountHeader(id: string) {
  const renderCustomHeader = lastCodeViewProps?.renderCustomHeader as (item: SeededItem) => React.ReactNode;
  if (!headerHost) {
    headerHost = document.createElement('div');
    document.body.appendChild(headerHost);
    headerRoot = createRoot(headerHost);
  }
  await act(async () => {
    headerRoot!.render(<>{renderCustomHeader(seededItem(id))}</>);
  });
  return headerHost;
}

function preview(paths: string[], calls: Array<[string, string]>) {
  return {
    previewedPaths: new Set(paths),
    isPreviewable: (file: DiffFile) => file.path.endsWith('.md'),
    show: (path: string, view: string) => { calls.push([path, view]); },
    renderViewControl: ({ file, touch }: { file: DiffFile; iconOnly: boolean; touch: boolean }) => (
      <span data-test-md-view-control={file.path} data-touch={String(touch)} />
    ),
    render: ({ file }: { file: DiffFile }) => <div data-test-md-preview={file.path} />,
  };
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  if (headerRoot) await act(async () => headerRoot?.unmount());
  host?.remove();
  headerHost?.remove();
  root = headerRoot = null;
  host = headerHost = null;
  lastCodeViewProps = null;
  updatedItems.length = 0;
  renderedItems = [];
  viewport = undefined;
  fakeEditingItemId = null;
  scrolls.length = 0;
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('Markdown previews in the all-files view', () => {
  test('a previewed Markdown file shows its card instead of diff rows; code files are untouched', async () => {
    const calls: Array<[string, string]> = [];
    await render({ markdownPreview: preview([mdFile.path], calls) });

    expect(seededItem(mdFile.path).fileDiff.hunks).toEqual([]);
    expect(seededItem(mdFile.path).fileDiff.cacheKey).toEndWith('#md-preview');
    expect(seededItem(codeFile.path).fileDiff.hunks.length).toBe(1);

    const header = await mountHeader(mdFile.path);
    expect(header.querySelector(`[data-test-md-preview="${mdFile.path}"]`)).not.toBeNull();
    expect(header.querySelector(`[data-test-md-view-control="${mdFile.path}"]`)?.getAttribute('data-touch')).toBe('false');

    const codeHeader = await mountHeader(codeFile.path);
    expect(codeHeader.querySelector('[data-test-md-view-control]')).toBeNull();
  });

  test('Source swaps the real diff back in place, and a rendered view swaps it out again', async () => {
    const calls: Array<[string, string]> = [];
    await render({ markdownPreview: preview([], calls) });
    expect(seededItem(mdFile.path).fileDiff.hunks.length).toBe(1);

    await rerender({ markdownPreview: preview([mdFile.path], calls) });
    const on = updatedItems.filter((u) => u.id === mdFile.path).at(-1)!;
    expect(on.fileDiff.hunks).toEqual([]);

    await rerender({ markdownPreview: preview([], calls) });
    const off = updatedItems.filter((u) => u.id === mdFile.path).at(-1)!;
    expect(off.fileDiff.hunks.length).toBe(1);
    expect(updatedItems.some((u) => u.id === codeFile.path)).toBe(false);
  });

  test('a search hit in a previewed file sends it back to Source', async () => {
    const calls: Array<[string, string]> = [];
    const match = { id: 'm1', filePath: mdFile.path, side: 'addition', lineNumber: 1, text: '# New', matchStart: 2, matchEnd: 5 };
    await render({ markdownPreview: preview([mdFile.path], calls) });
    await rerender({ markdownPreview: preview([mdFile.path], calls), activeSearchMatch: match as never, activeSearchMatchId: 'm1' });
    expect(calls).toContainEqual([mdFile.path, 'source']);
  });

  test('tells the host which file the edit session holds, so its view is locked', async () => {
    const editing: Array<string | null> = [];
    fakeEditingItemId = mdFile.path;
    await render({
      markdownPreview: { ...preview([], []), onEditingFileChange: (path: string | null) => { editing.push(path); } },
      enableEditSuggestions: true,
      onAddSuggestionsForFile: () => {},
    });
    expect(editing.at(-1)).toBe(mdFile.path);
    fakeEditingItemId = null;
    await rerender({
      markdownPreview: { ...preview([], []), onEditingFileChange: (path: string | null) => { editing.push(path); } },
      enableEditSuggestions: true,
      onAddSuggestionsForFile: () => {},
    });
    expect(editing.at(-1)).toBeNull();
  });

  test('the file in an edit session keeps its diff; the swap held back runs once the edit ends, and search scrolls there', async () => {
    const calls: Array<[string, string]> = [];
    const editProps = { files: [mdFile, codeFile], enableEditSuggestions: true, onAddSuggestionsForFile: () => {} };
    fakeEditingItemId = mdFile.path;
    await render({ markdownPreview: preview([], calls), ...editProps });
    const held = preview([mdFile.path], calls);
    await rerender({ markdownPreview: held, ...editProps });
    expect(updatedItems.some((u) => u.id === mdFile.path)).toBe(false);

    const match = { id: 'm1', filePath: mdFile.path, side: 'addition', lineNumber: 1, text: '# New', matchStart: 2, matchEnd: 5 };
    await rerender({ markdownPreview: held, ...editProps, activeSearchMatch: match as never, activeSearchMatchId: 'm1' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(calls).not.toContainEqual([mdFile.path, 'source']);
    expect(scrolls).toContain(mdFile.path);

    fakeEditingItemId = null;
    await rerender({ markdownPreview: held, ...editProps, activeSearchMatch: match as never, activeSearchMatchId: 'm1' });
    expect(updatedItems.filter((u) => u.id === mdFile.path).at(-1)?.fileDiff.hunks).toEqual([]);
  });

  test('P never picks a file in the overscan: focus counts only inside the viewport', async () => {
    let resolve: (() => string | null) | null = null;
    const secondMd: DiffFile = { ...mdFile, path: 'docs/notes.md', patch: mdFile.patch.replaceAll('docs/guide.md', 'docs/notes.md') };
    const box = (top: number, bottom: number) => {
      const el = document.createElement('div');
      el.tabIndex = 0;
      el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
      document.body.appendChild(el);
      return el;
    };
    viewport = box(0, 600);
    const offscreen = box(700, 900);
    renderedItems = [
      { id: mdFile.path, element: box(0, 400) },
      { id: secondMd.path, element: offscreen },
    ];
    await render({
      files: [mdFile, secondMd],
      markdownPreview: { ...preview([], []), registerViewTarget: (fn: (() => string | null) | null) => { resolve = fn; } },
    });
    offscreen.focus();
    expect(document.activeElement).toBe(offscreen);
    expect(resolve!()).toBe(mdFile.path);
  });

  test('P acts on the Markdown file under the pointer, else the top-most Markdown file in view (never just the last)', async () => {
    let resolve: (() => string | null) | null = null;
    const secondMd: DiffFile = { ...mdFile, path: 'docs/notes.md', patch: mdFile.patch.replaceAll('docs/guide.md', 'docs/notes.md') };
    const box = (top: number, bottom: number) => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
      document.body.appendChild(el);
      return el;
    };
    viewport = box(0, 600);
    renderedItems = [
      { id: codeFile.path, element: box(0, 100) },
      { id: mdFile.path, element: box(100, 300) },
      { id: secondMd.path, element: box(300, 500) },
    ];
    await render({
      files: [codeFile, mdFile, secondMd],
      markdownPreview: { ...preview([], []), registerViewTarget: (fn: (() => string | null) | null) => { resolve = fn; } },
    });
    expect(resolve).not.toBeNull();
    expect(resolve!()).toBe(mdFile.path);

    const surface = host!.firstElementChild as HTMLElement;
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 400 }));
    });
    expect(resolve!()).toBe(secondMd.path);
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 50 }));
    });
    expect(resolve!()).toBeNull();
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(resolve!()).toBe(mdFile.path);
  });

  test('without the host seam (guide chain, guides.show) nothing is previewed', async () => {
    await render();
    expect(seededItem(mdFile.path).fileDiff.hunks.length).toBe(1);
    const header = await mountHeader(mdFile.path);
    expect(header.querySelector('[data-test-md-view-control]')).toBeNull();
    expect(header.querySelector('[data-markdown-view-menu]')).toBeNull();
  });
});
