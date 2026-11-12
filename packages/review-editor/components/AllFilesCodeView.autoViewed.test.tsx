import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffs = { ...(await import('@pierre/diffs')) };
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

const ITEM_TOPS: Record<string, number> = {
  'a.ts': 0,
  'b.ts': 1000,
  'c.ts': 2000,
};
const SCROLL_HEIGHT = 3000;
const VIEWPORT_HEIGHT = 500;

const viewerState = {
  scrollTop: 0,
  collapsed: new Set<string>(),
  scrollHeight: SCROLL_HEIGHT,
  height: VIEWPORT_HEIGHT,
};
let emitScroll: ((position: number) => void) | null = null;
let lastCodeViewProps: Record<string, unknown> | null = null;

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
    props: {
      initialItems?: Array<{ id: string }>;
      className?: string;
      containerRef?: React.Ref<HTMLDivElement>;
      onScroll?: (position: number) => void;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    const itemsRef = useRef(new Map((props.initialItems ?? []).map((item) => [item.id, item])));
    lastCodeViewProps = props as unknown as Record<string, unknown>;
    useEffect(() => {
      emitScroll = (position: number) => props.onScroll?.(position);
      return () => { emitScroll = null; };
    });
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => {
        const item = itemsRef.current.get(id);
        if (!item) return undefined;
        return { ...item, collapsed: viewerState.collapsed.has(id) };
      },
      updateItem: (item: { id: string }) => {
        itemsRef.current.set(item.id, item);
        return true;
      },
      updateItemId: () => true,
      scrollTo: () => {},
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => [...itemsRef.current.keys()].map((id) => ({ id })),
        getScrollTop: () => viewerState.scrollTop,
        getScrollHeight: () => viewerState.scrollHeight,
        getHeight: () => viewerState.height,
        getTopForItem: (id: string) => ITEM_TOPS[id],
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
let root: Root | null = null;
let host: HTMLElement | null = null;

function makeFile(path: string): DiffFile {
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
    status: 'modified',
  };
}

const FILES = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];

type Props = Partial<React.ComponentProps<typeof AllFilesCodeView>>;

async function render(overrides: Props = {}) {
  if (!host) {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <AllFilesCodeView
        files={FILES}
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
        {...overrides}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

async function scrollTo(position: number) {
  viewerState.scrollTop = position;
  await act(async () => {
    emitScroll?.(position);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lastCodeViewProps = null;
  viewerState.scrollTop = 0;
  viewerState.collapsed = new Set();
  viewerState.scrollHeight = SCROLL_HEIGHT;
  viewerState.height = VIEWPORT_HEIGHT;
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('AllFilesCodeView auto-view emission', () => {
  test('scrolling down past a file emits it once its successor reaches the top', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });

    await scrollTo(400);
    expect(passed).toEqual([]);

    await scrollTo(1000);
    expect(passed).toEqual(['a.ts']);
  });

  test('a downward move whose predecessor is still on screen emits nothing', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(400);
    await scrollTo(950);
    expect(passed).toEqual([]);
  });

  test('a pass whose geometry lands in the threshold gap resolves on a later tick', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(400);
    await scrollTo(960);
    expect(passed).toEqual([]);
    await scrollTo(1100);
    expect(passed).toEqual(['a.ts']);
  });

  test('a candidate abandoned by scrolling back up is dropped, not banked', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(400);
    await scrollTo(960);
    await scrollTo(0);
    await scrollTo(400);
    expect(passed).toEqual([]);
  });

  test('scrolling back UP never emits', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(1000);
    passed.length = 0;
    await scrollTo(0);
    await scrollTo(400);
    expect(passed).toEqual([]);
  });

  test('a collapsed card never emits when passed', async () => {
    const passed: string[] = [];
    viewerState.collapsed = new Set(['a.ts']);
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(400);
    await scrollTo(1000);
    expect(passed).toEqual([]);
  });

  test('reaching the bottom emits the last file, which can never scroll out above', async () => {
    const passed: string[] = [];
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(2500);
    expect(passed).toContain('c.ts');
  });

  test('a collapsed last file is not emitted at the bottom either', async () => {
    const passed: string[] = [];
    viewerState.collapsed = new Set(['c.ts']);
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await scrollTo(2500);
    expect(passed).not.toContain('c.ts');
  });

  test('the reading-file report carries the collapsed flag', async () => {
    const reports: Array<[string | null, boolean | undefined]> = [];
    viewerState.collapsed = new Set(['b.ts']);
    await render({
      onVisibleFileChange: (path, info) => reports.push([path, info?.collapsed]),
    });
    await scrollTo(1000);
    expect(reports.at(-1)).toEqual(['b.ts', true]);
  });

  test('a diff that fits the viewport marks nothing until the reader actually scrolls', async () => {
    const passed: string[] = [];
    viewerState.scrollHeight = 400;
    viewerState.height = 400;
    await render({ onFileScrolledPast: (path) => passed.push(path) });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(passed).toEqual([]);

    await scrollTo(0);
    expect(passed).toEqual(['c.ts']);
  });

  test('without the handler the component behaves exactly as before', async () => {
    const reports: Array<string | null> = [];
    await render({ onVisibleFileChange: (path) => reports.push(path) });
    await scrollTo(1000);
    expect(reports.at(-1)).toBe('b.ts');
    expect(lastCodeViewProps).not.toBeNull();
  });
});
