import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

let itemHost: HTMLElement | null = null;
let renderAgain: () => void = () => {};
let clickArrow: () => Promise<unknown> = async () => undefined;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

type Item = { id: string; type: 'diff'; collapsed?: boolean; fileDiff: unknown };
mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Item[]; className?: string; containerRef?: React.Ref<HTMLDivElement>; options?: { onPostRender?: (node: HTMLElement, instance: unknown, phase: string, context: { item: Item }) => void; loadDiffFiles?: (fileDiff: unknown) => Promise<unknown> } },
    ref: React.ForwardedRef<unknown>,
  ) {
    const itemsRef = useRef(new Map((props.initialItems ?? []).map((item) => [item.id, item])));
    const element = useRef(document.createElement('div'));
    itemHost = element.current;
    renderAgain = () => {
      for (const item of itemsRef.current.values()) props.options?.onPostRender?.(element.current, {}, 'update', { item });
    };
    clickArrow = () => props.options!.loadDiffFiles!([...itemsRef.current.values()][0]!.fileDiff);    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => itemsRef.current.get(id),
      updateItem: () => true,
      updateItemId: () => true,
      scrollTo: () => {},
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => [...itemsRef.current.values()].map((item) => ({ id: item.id, item, element: element.current })),
        getScrollTop: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        getTopForItem: () => 0,
        scrollTo: () => {},
      }),
    }));
    useEffect(() => {
      for (const item of itemsRef.current.values()) props.options?.onPostRender?.(element.current, {}, 'mount', { item });
    }, []);
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
    useImperativeHandle(ref, () => ({ handleLineSelectionEnd: () => {}, openLineAnnotation: () => {}, handleTokenClick: () => {}, startEdit: () => {} }));
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const OLD = ['one', 'two', 'three', 'four', 'five'];
const NEW = ['one', 'two', 'THREE', 'four', 'five'];
const file: DiffFile = {
  path: 'a.ts',
  patch: 'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n',
  additions: 1,
  deletions: 1,
  status: 'modified',
};
const text = (lines: string[]) => `${lines.join('\n')}\n`;

async function render(read: (file: DiffFile, signal: AbortSignal) => Promise<{ oldContent: string | null; newContent: string | null } | null>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AllFilesCodeView
        files={[file]}
        diffStyle="unified"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        scrollsWithPage
        flushFiles
        fetchFileContent={read}
        onContentHeightChange={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 25)));

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  itemHost = null;
  renderAgain = () => {};
  clickArrow = async () => undefined;
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('flush files: the row after the last hunk', () => {
  test('a file that goes on after its last change draws no row there, and nothing is read for it', async () => {
    const reads: string[] = [];
    await render(async (asked) => {
      reads.push(asked.path);
      return { oldContent: text([...OLD, 'six', 'seven']), newContent: text([...NEW, 'six', 'seven']) };
    });
    await settle();
    expect(reads).toEqual([]);
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
  });

  test('a file that renders again keeps the row hidden and still reads nothing', async () => {
    let reads = 0;
    await render(async () => {
      reads += 1;
      return { oldContent: text([...OLD, 'six']), newContent: text([...NEW, 'six']) };
    });
    await settle();
    await act(async () => renderAgain());
    await settle();
    expect(reads).toBe(0);
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
  });

  test("an arrow opens the file's whole text with one read", async () => {
    let reads = 0;
    await render(async () => {
      reads += 1;
      return { oldContent: text([...OLD, 'six']), newContent: text([...NEW, 'six']) };
    });
    let opened: unknown = null;
    await act(async () => void clickArrow().then((files) => (opened = files)));
    await settle();
    expect(reads).toBe(1);
    expect(opened).toMatchObject({ newFile: { name: 'a.ts', contents: text([...NEW, 'six']) } });
  });
});
