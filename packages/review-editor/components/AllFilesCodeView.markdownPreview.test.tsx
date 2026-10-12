/**
 * DOM-gated tests (DOM_TESTS=1) for Markdown previews in the all-files view.
 * Registered in .github/workflows/test.yml's "Run UI seam-contract + DOM
 * tests" step (it mocks @pierre/diffs, so it runs with --isolate).
 *
 * The contract under guard: a previewed Markdown file's card replaces its
 * diff rows. Its CodeView item carries a hunkless diff (so Pierre draws
 * nothing under the header slot that holds the preview) and gets the real
 * diff back the moment the file goes back to Source; the header offers
 * Source | Preview; a search hit in a previewed file sends it back to Source.
 * A host that passes no `markdownPreview` (the guide chain, guides.show) gets
 * none of it.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

let lastCodeViewProps: Record<string, unknown> | null = null;
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
  // One stand-in hunk per patch that has one, so "hunkless" is observable.
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

/** Mount one item's custom header the way CodeView's header slot would. */
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

function preview(paths: string[], calls: Array<[string, boolean]>) {
  return {
    previewedPaths: new Set(paths),
    isPreviewable: (file: DiffFile) => file.path.endsWith('.md'),
    setPreview: (path: string, on: boolean) => { calls.push([path, on]); },
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
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('Markdown previews in the all-files view', () => {
  test('a previewed Markdown file shows its card instead of diff rows; code files are untouched', async () => {
    const calls: Array<[string, boolean]> = [];
    await render({ markdownPreview: preview([mdFile.path], calls) });

    expect(seededItem(mdFile.path).fileDiff.hunks).toEqual([]);
    expect(seededItem(mdFile.path).fileDiff.cacheKey).toEndWith('#md-preview');
    expect(seededItem(codeFile.path).fileDiff.hunks.length).toBe(1);

    const header = await mountHeader(mdFile.path);
    expect(header.querySelector(`[data-test-md-preview="${mdFile.path}"]`)).not.toBeNull();
    expect(header.querySelector('[data-markdown-preview-toggle]')?.getAttribute('data-markdown-preview-on')).toBe('true');
    await act(async () => header.querySelector<HTMLButtonElement>('[data-markdown-preview-source]')!.click());
    expect(calls).toEqual([[mdFile.path, false]]);

    const codeHeader = await mountHeader(codeFile.path);
    expect(codeHeader.querySelector('[data-markdown-preview-toggle]')).toBeNull();
  });

  test('Source swaps the real diff back in place, and Preview swaps it out again', async () => {
    const calls: Array<[string, boolean]> = [];
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
    const calls: Array<[string, boolean]> = [];
    const match = { id: 'm1', filePath: mdFile.path, side: 'addition', lineNumber: 1, text: '# New', matchStart: 2, matchEnd: 5 };
    await render({ markdownPreview: preview([mdFile.path], calls) });
    await rerender({ markdownPreview: preview([mdFile.path], calls), activeSearchMatch: match as never, activeSearchMatchId: 'm1' });
    expect(calls).toContainEqual([mdFile.path, false]);
  });

  test('without the host seam (guide chain, guides.show) nothing is previewed', async () => {
    await render();
    expect(seededItem(mdFile.path).fileDiff.hunks.length).toBe(1);
    const header = await mountHeader(mdFile.path);
    expect(header.querySelector('[data-markdown-preview-toggle]')).toBeNull();
  });
});
