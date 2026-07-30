import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

let codeViewMounts = 0;
let codeViewUnmounts = 0;
let scrollTargets: Array<Record<string, unknown>> = [];

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('@pierre/diffs', () => ({
  getSingularPatch: (patch: string) => ({
    name: patch.includes('target.ts') ? 'target.ts' : 'file.ts',
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
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    const itemsRef = useRef(new Map((props.initialItems ?? []).map((item) => [item.id, item])));
    useEffect(() => {
      codeViewMounts += 1;
      return () => {
        codeViewUnmounts += 1;
      };
    }, []);
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => itemsRef.current.get(id),
      updateItem: (item: { id: string }) => {
        itemsRef.current.set(item.id, item);
        return true;
      },
      updateItemId: () => true,
      scrollTo: (target: Record<string, unknown>) => scrollTargets.push(target),
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getRenderedItems: () => [],
        getScrollTop: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        getTopForItem: () => 0,
        scrollTo: (target: Record<string, unknown>) => scrollTargets.push(target),
      }),
    }));
    return <div ref={props.containerRef} className={props.className} />;
  }),
  useStableCallback: <T extends (...args: never[]) => unknown>(callback: T): T => {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;
    return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
  },
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const file: DiffFile = {
  path: 'target.ts',
  patch: 'diff --git a/target.ts b/target.ts\n--- a/target.ts\n+++ b/target.ts\n@@ -1 +1 @@\n-old\n+new',
  additions: 1,
  deletions: 1,
  status: 'modified',
};

function view(overrides: Partial<React.ComponentProps<typeof AllFilesCodeView>> = {}) {
  return (
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
      {...overrides}
    />
  );
}

async function render(overrides: Partial<React.ComponentProps<typeof AllFilesCodeView>> = {}) {
  await act(async () => {
    root!.render(view(overrides));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  codeViewMounts = 0;
  codeViewUnmounts = 0;
  scrollTargets = [];
});

describe('AllFilesCodeView guide mount state', () => {
  test.skipIf(!hasDom)('does not remount when the live shell collapse value changes', async () => {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);

    await render({ mountCollapsed: false });
    expect(codeViewMounts).toBe(1);

    await render({ mountCollapsed: true });
    expect(codeViewMounts).toBe(1);
    expect(codeViewUnmounts).toBe(0);
  });

  test.skipIf(!hasDom)('restores the initial scroll position only once per mount', async () => {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);

    await render({ initialScrollPosition: 120 });
    await render({ initialScrollPosition: 360 });

    expect(scrollTargets.filter((target) => target.type === 'position')).toEqual([
      { type: 'position', position: 120 },
    ]);
  });
});
