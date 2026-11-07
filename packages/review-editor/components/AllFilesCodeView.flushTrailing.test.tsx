/**
 * Flush files (the Inbox's PR page): the row after an unread file's last hunk. Its length is read with the host's
 * whole-file reader when the file renders; the row shows "N unmodified lines" only when N > 0, and stays hidden while
 * unknown or when the last hunk reaches the end of the file.
 *
 * CodeView is a stand-in that renders the one item through `onPostRender` on a host element of its own, the way
 * Pierre hands AllFilesCodeView its `<diffs-container>`; the item is the real partial diff of the patch.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

/** The stand-in's host element for its one item, as Pierre's `<diffs-container>`. */
let itemHost: HTMLElement | null = null;
/** The item renders again (a scroll, an update): Pierre calls `onPostRender` once more. */
let renderAgain: () => void = () => {};
/** An expand arrow's first click: Pierre calls the loader it was given. */
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
      // Once, as the item first renders.
      // eslint-disable-next-line react-hooks/exhaustive-deps
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

// Line 3 of a file changes; the hunk shows lines 1 to 5. The index line names its blobs, as a forge's patch does.
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
  test('a file with lines after its last change gets "N unmodified lines" once its length is known', async () => {
    let answer: (value: { oldContent: string; newContent: string }) => void = () => {};
    const reads: string[] = [];
    await render((asked) => {
      reads.push(asked.path);
      return new Promise((resolve) => (answer = resolve));
    });
    // Unknown: nothing shows, and the row's room is given back.
    expect(reads).toEqual(['a.ts']);
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
    expect(itemHost!.hasAttribute('data-trailing-count')).toBe(false);
    await act(async () => answer({ oldContent: text([...OLD, 'six', 'seven']), newContent: text([...NEW, 'six', 'seven']) }));
    await settle();
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(false);
    expect(itemHost!.hasAttribute('data-trailing-count')).toBe(true);
    expect(itemHost!.style.getPropertyValue('--pn-trailing-label')).toBe('"2 unmodified lines"');
  });

  test('a file whose last change reaches its end never gets the row', async () => {
    await render(async () => ({ oldContent: text(OLD), newContent: text(NEW) }));
    await settle();
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
    expect(itemHost!.hasAttribute('data-trailing-count')).toBe(false);
    expect(itemHost!.style.getPropertyValue('--pn-trailing-label')).toBe('');
  });

  test('a failed read keeps the row hidden and is not asked again when the file renders again', async () => {
    let reads = 0;
    await render(async () => {
      reads += 1;
      throw new Error('forge refused');
    });
    await settle();
    await act(async () => renderAgain());
    await settle();
    expect(reads).toBe(1);
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
    expect(itemHost!.hasAttribute('data-trailing-count')).toBe(false);
  });

  test('a file that renders again keeps its count and reads nothing more', async () => {
    let reads = 0;
    await render(async () => {
      reads += 1;
      return { oldContent: text([...OLD, 'six']), newContent: text([...NEW, 'six']) };
    });
    await settle();
    await act(async () => renderAgain());
    await settle();
    expect(reads).toBe(1);
    expect(itemHost!.style.getPropertyValue('--pn-trailing-label')).toBe('"1 unmodified line"');
  });

  test('an arrow clicked while the count is on its way shares that read', async () => {
    let reads = 0;
    let answer: (value: { oldContent: string; newContent: string }) => void = () => {};
    await render(() => {
      reads += 1;
      return new Promise((resolve) => (answer = resolve));
    });
    let opened: unknown = null;
    await act(async () => void clickArrow().then((files) => (opened = files)));
    expect(reads).toBe(1);
    await act(async () => answer({ oldContent: text(OLD), newContent: text(NEW) }));
    await settle();
    expect(reads).toBe(1);
    expect(opened).toMatchObject({ newFile: { name: 'a.ts', contents: text(NEW) } });
  });

  test('leaving the page stops a count still on its way', async () => {
    let signal: AbortSignal | null = null;
    await render((_file, given) => {
      signal = given;
      return new Promise(() => {});
    });
    expect(signal!.aborted).toBe(false);
    await act(async () => root!.unmount());
    root = null;
    expect(signal!.aborted).toBe(true);
  });

  test('no text to count (the reader has none) leaves the row hidden', async () => {
    await render(async () => null);
    await settle();
    expect(itemHost!.hasAttribute('data-trailing-unread')).toBe(true);
    expect(itemHost!.hasAttribute('data-trailing-count')).toBe(false);
  });
});
