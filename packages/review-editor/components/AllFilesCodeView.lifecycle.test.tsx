import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectedLineRange } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

let codeViewMounts = 0;
let codeViewUnmounts = 0;
let scrollTargets: Array<Record<string, unknown>> = [];
let lastCodeViewProps: Record<string, unknown> | null = null;
let toolbarSelections: Array<SelectedLineRange | null> = [];

// Captured BEFORE the mocks below replace the specifiers, so this file can put
// the real modules back when it is done. `mock.module` is process global and
// bun does not unwind it at file boundaries: without this, every later file in
// the same run sees this file's stubs — a `getSingularPatch` with no hunks and
// a `processFile` that returns null. That leaked into
// DiffViewer.fullContentSwap.test.tsx on the Linux runner (and not on macOS),
// where it presented as a diff that silently never rendered.
//
// The SPREAD is load-bearing, exactly as configure.test.ts documents. A
// namespace object is a live view of the module record, and `mock.module`
// rewrites that record in place — so holding `await import(...)` and handing it
// back later re-installs the STUBS as themselves and restores nothing. Spread
// snapshots the real export values into a plain object at capture time, before
// any stub exists.
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
    lastCodeViewProps = props as unknown as Record<string, unknown>;
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
  // AllFilesCodeView imports EditProvider alongside CodeView/useStableCallback.
  // mock.module replaces the whole specifier, so every value export the
  // component reads must be present here or the import throws at load time.
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
      handleLineSelectionEnd: (range: SelectedLineRange | null) => {
        toolbarSelections.push(range);
      },
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
  lastCodeViewProps = null;
  toolbarSelections = [];
});

// Hand the real @pierre/diffs back to the process. Only the two library
// specifiers are restored. The sibling-module mocks above are NOT scoped to
// this file — `mock.module` resolves a relative specifier to an absolute module
// path, so any later file importing packages/review-editor/workerPool,
// hooks/usePierreTheme or components/ToolbarHost sees these stubs too. They are
// left in place because workerPool cannot be captured here at all: it imports
// the Vite-only `?worker&inline` virtual module, which bun cannot resolve.
// Files that need the real ones must not share this process — that is what the
// isolated "diff-renderer DOM tests" step in .github/workflows/test.yml is for.
afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

// Guards the capture idiom itself. If the spreads above are ever reduced back
// to a bare `await import(...)`, the "real" handles become live views of the
// mocked module records and the afterAll restore silently degrades to a no-op —
// which is how discardRestoreRender.test.tsx started seeing `processFile()`
// return null on the runs where the runner walked this file first.
describe('the @pierre/diffs restore handles', () => {
  test('hold the real exports, not the stubs installed over them', async () => {
    const stubbed = await import('@pierre/diffs');
    const stubbedReact = await import('@pierre/diffs/react');

    // The live namespaces are this file's stubs: `processFile: () => null`.
    expect(stubbed.processFile.length).toBe(0);

    // The captured handles must not have followed them.
    expect(realPierreDiffs.processFile).not.toBe(stubbed.processFile);
    expect(realPierreDiffs.processFile.length).toBe(2);
    expect(realPierreDiffsReact.CodeView).not.toBe(stubbedReact.CodeView);
  });
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

describe('AllFilesCodeView compact-touch line selection', () => {
  // Stands in for App: a published range comes straight back down as
  // `pendingSelection`. That loop is load-bearing — CodeView's selection is
  // controlled, and the reconcile effect clears the highlight whenever
  // pendingSelection is null, so a statically-null prop would wipe the range
  // the preserve branch just painted.
  function Harness({ compactTouchLayout, onSelection }: {
    compactTouchLayout: boolean;
    onSelection?: (range: SelectedLineRange | null) => void;
  }) {
    const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
    return view({
      compactTouchLayout,
      pendingSelection,
      onLineSelection: (range) => {
        onSelection?.(range);
        setPendingSelection(range);
      },
    });
  }

  async function mount(
    compactTouchLayout: boolean,
    onSelection?: (range: SelectedLineRange | null) => void,
  ) {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness compactTouchLayout={compactTouchLayout} onSelection={onSelection} />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }

  function getSelectionCallbacks() {
    const options = lastCodeViewProps?.options as {
      onLineSelectionEnd?: (
        range: SelectedLineRange | null,
        context: { item: { id: string; type: 'diff' } },
      ) => void;
      onGutterUtilityClick?: (
        range: SelectedLineRange,
        context: { item: { id: string; type: 'diff' } },
      ) => void;
    };
    const item = (lastCodeViewProps?.initialItems as Array<{ id: string; type: 'diff' }>)[0];
    return { options, item };
  }

  test.skipIf(!hasDom)('preserves a dragged range, then opens the composer from the gutter action', async () => {
    const observedSelections: Array<SelectedLineRange | null> = [];
    const range: SelectedLineRange = { start: 4, end: 8, side: 'additions' };
    await mount(true, (selection) => observedSelections.push(selection));
    const { options, item } = getSelectionCallbacks();

    await act(async () => {
      options.onLineSelectionEnd?.(range, { item });
    });

    expect(observedSelections.at(-1)).toEqual(range);
    expect(toolbarSelections).toEqual([]);
    // Publishing the range upward is only half of "preserved": CodeView's
    // selection is controlled here, so the highlight only survives if the range
    // is also handed back down. Without this the composer would stay shut on a
    // range nothing paints.
    expect(lastCodeViewProps?.selectedLines).toEqual({ id: item.id, range });

    await act(async () => {
      options.onGutterUtilityClick?.(range, { item });
    });

    expect(toolbarSelections).toEqual([range]);
  });

  test.skipIf(!hasDom)('keeps the incumbent desktop selection-to-composer transition', async () => {
    const range: SelectedLineRange = { start: 4, end: 8, side: 'additions' };
    await mount(false);
    const { options, item } = getSelectionCallbacks();

    await act(async () => {
      options.onLineSelectionEnd?.(range, { item });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(toolbarSelections).toEqual([range]);
  });
});

describe('AllFilesCodeView readOnly (portable guide host)', () => {
  // The portable Guided Review viewer renders this component with no server
  // and no review state behind it (decision record D2/D4). These guard the
  // three things read-only must switch off without changing what the diff
  // LOOKS like: selection affordances, the window keydown handler, and the
  // /api/file-content augmentation fetch.
  async function mount(overrides: Partial<React.ComponentProps<typeof AllFilesCodeView>>) {
    // A second mount inside one test replaces the previous tree instead of leaking it.
    if (root) await act(async () => root?.unmount());
    host?.remove();
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    root = createRoot(host);
    await render(overrides);
  }

  test.skipIf(!hasDom)('turns off line and gutter selection only in read-only mode', async () => {
    await mount({ readOnly: true });
    let options = lastCodeViewProps?.options as Record<string, unknown>;
    expect(options.enableLineSelection).toBe(false);
    expect(options.enableGutterUtility).toBe(false);

    // The default-on half catches an inverted `!readOnly` breaking the in-app reviewer.
    await mount({});
    options = lastCodeViewProps?.options as Record<string, unknown>;
    expect(options.enableLineSelection).toBe(true);
    expect(options.enableGutterUtility).toBe(true);
  });

  test.skipIf(!hasDom)('never fetches file content when an item mounts', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ oldContent: 'a', newContent: 'b' }), { status: 200 }));
    }) as typeof fetch;
    try {
      await mount({ readOnly: true, isActive: true });
      const options = lastCodeViewProps?.options as { onPostRender?: (...args: unknown[]) => void };
      const item = { id: 'target.ts', type: 'diff' };
      await act(async () => {
        options.onPostRender?.(document.createElement('div'), {}, 'mount', { item });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(calls.filter((url) => url.includes('/api/file-content'))).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.skipIf(!hasDom)('control: a live host does fetch file content on item mount', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ oldContent: null, newContent: null }), { status: 200 }));
    }) as typeof fetch;
    try {
      await mount({ isActive: true });
      const options = lastCodeViewProps?.options as { onPostRender?: (...args: unknown[]) => void };
      await act(async () => {
        options.onPostRender?.(document.createElement('div'), {}, 'mount', { item: { id: 'target.ts', type: 'diff' } });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(calls.filter((url) => url.includes('/api/file-content'))).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.skipIf(!hasDom)('does not install the window keydown handler', async () => {
    const originalAdd = window.addEventListener;
    const keydownAdds: number[] = [];
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'keydown') keydownAdds.push(1);
      return (originalAdd as unknown as (...a: unknown[]) => unknown).call(window, type, ...rest);
    }) as typeof window.addEventListener;
    try {
      await mount({ readOnly: true, isActive: true });
      expect(keydownAdds).toHaveLength(0);
    } finally {
      window.addEventListener = originalAdd;
    }
  });
});
