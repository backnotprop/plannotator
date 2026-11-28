import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

const ROW = 30;
const FILE = 3000;
let VIEW = 200;
/** Space above the first file (the review's leading content). Most tests
 *  start the first change below the middle of the view; one starts at 0. */
let LEAD = 200;

let scrollTop = 0;
/** Item ids the stand-in leaves out of its rendered window. */
let notRendered = new Set<string>();
let collapsedIds = new Set<string>();
let rangeScrolls: string[] = [];

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
        if (target.type === 'range') rangeScrolls.push(target.id);
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

const patch = (path: string, body: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ''].join('\n');

const FILES: DiffFile[] = [
  { path: 'a.ts', patch: patch('a.ts', ['@@ -1,3 +1,3 @@', ' a1', '-a2', '+A2', ' a3']), additions: 1, deletions: 1, status: 'modified' },
  { path: 'users.ts', patch: patch('users.ts', ['@@ -1,3 +1,3 @@', ' u1', '-u2', '+U2', ' u3']), additions: 1, deletions: 1, status: 'modified' },
];

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('a line target from another panel lands in All files', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    rangeScrolls = [];
    notRendered = new Set();
    collapsedIds = new Set();
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  const view = (files: DiffFile[], lineTarget: React.ComponentProps<typeof AllFilesCodeView>['lineTarget']) => (
    <AllFilesCodeView
      files={files}
      diffStyle="unified"
      annotations={[]}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={null}
      isActive
      lineTarget={lineTarget}
      onLineSelection={() => {}}
      onAddAnnotationForFile={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
    />
  );

  test('the files changing before its frame does not lose the jump', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(view(FILES, null)));
    const target = { path: 'users.ts', range: { start: 2, end: 2, side: 'additions' as const }, token: 1 };
    act(() => root!.render(view(FILES, target)));
    act(() => root!.render(view([...FILES], target)));
    for (let turn = 0; turn < 20 && rangeScrolls.length === 0; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(rangeScrolls).toEqual(['users.ts']);
  });
});
