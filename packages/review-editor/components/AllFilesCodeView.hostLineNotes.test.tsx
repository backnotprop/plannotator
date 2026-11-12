import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import type { HostFileNote, HostLineNote } from './hostLineNotes';

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

type Ann = { side: string; lineNumber: number; metadata: { annotationId: string; kind?: string } };
type Item = { id: string; type: 'diff'; version?: number; annotations: Ann[]; fileDiff: unknown };
let items = new Map<string, Item>();
let updates: string[] = [];
let renderAnnotation: (annotation: Ann, fileDiff: unknown, item: Item) => React.ReactNode = () => null;
let renderCustomHeader: (item: Item) => React.ReactNode = () => null;
let viewOptions: { itemMetrics?: { diffHeaderHeight?: number } } = {};

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Item[]; containerRef?: React.Ref<HTMLDivElement>; className?: string; renderAnnotation: typeof renderAnnotation; renderCustomHeader: typeof renderCustomHeader; options?: typeof viewOptions },
    ref: React.ForwardedRef<unknown>,
  ) {
    const seeded = useRef(false);
    if (!seeded.current) {
      seeded.current = true;
      items = new Map((props.initialItems ?? []).map((item) => [item.id, { ...item, annotations: [...item.annotations] }]));
    }
    renderAnnotation = props.renderAnnotation;
    renderCustomHeader = props.renderCustomHeader;
    viewOptions = props.options ?? {};
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => items.get(id),
      updateItem: (item: Item) => {
        updates.push(item.id);
        items.set(item.id, { ...item, annotations: [...item.annotations] });
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
    useImperativeHandle(ref, () => ({ handleLineSelectionEnd: () => {}, openLineAnnotation: () => {}, handleTokenClick: () => {}, startEdit: () => {} }));
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const fileOf = (path: string): DiffFile => ({
  path,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`,
  additions: 1,
  deletions: 1,
  status: 'modified',
});
const files = [fileOf('a.ts'), fileOf('b.ts')];
const mine: CodeAnnotation = { id: 'mine', type: 'comment', scope: 'line', filePath: 'a.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'my words', createdAt: 1 };
const note = (id: string, filePath: string, key = id, line = 2): HostLineNote => ({ id, filePath, line, side: 'new', key, render: () => <i data-note={id}>{key}</i> });

function draw(hostLineNotes?: readonly HostLineNote[], annotations: CodeAnnotation[] = [mine], hostFileNotes?: readonly HostFileNote[], shown: DiffFile[] = files) {
  return act(async () => {
    root!.render(
      <AllFilesCodeView
        files={shown}
        diffStyle="unified"
        annotations={annotations}
        {...(hostLineNotes ? { hostLineNotes } : {})}
        {...(hostFileNotes ? { hostFileNotes } : {})}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        scrollsWithPage
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(hostLineNotes?: readonly HostLineNote[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await draw(hostLineNotes);
}

const kinds = (id: string) => items.get(id)!.annotations.map((a) => `${a.metadata.kind ?? 'annotation'}:${a.metadata.annotationId}`);
const drawn = (id: string, index: number) => renderToStaticMarkup(<>{renderAnnotation(items.get(id)!.annotations[index]!, items.get(id)!.fileDiff, items.get(id)!)}</>);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  items = new Map();
  updates = [];
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)("the host's notes under lines", () => {
  test('seeded with the diff, above the person\'s own comment on the line, drawn by the host', async () => {
    await mount([note('t1', 'a.ts')]);
    expect(kinds('a.ts')).toEqual(['host-note:t1', 'annotation:mine']);
    expect(drawn('a.ts', 0)).toBe('<i data-note="t1">t1</i>');
    expect(kinds('b.ts')).toEqual([]);
  });

  test('notes that come after the diff drew: only their file is drawn again', async () => {
    await mount([]);
    expect(kinds('a.ts')).toEqual(['annotation:mine']);
    await draw([note('t2', 'b.ts')]);
    expect(updates).toEqual(['b.ts']);
    expect(kinds('b.ts')).toEqual(['host-note:t2']);
    expect(drawn('b.ts', 0)).toBe('<i data-note="t2">t2</i>');
  });

  test('the same notes again (a new array, the same keys) draw nothing; a changed key draws its file; a gone note goes', async () => {
    await mount([note('t1', 'a.ts'), note('t2', 'b.ts')]);
    await draw([note('t1', 'a.ts'), note('t2', 'b.ts')]);
    expect(updates).toEqual([]);
    await draw([note('t1', 'a.ts', 't1-new comment'), note('t2', 'b.ts')]);
    expect(updates).toEqual(['a.ts']);
    expect(drawn('a.ts', 0)).toBe('<i data-note="t1">t1-new comment</i>');
    await draw([note('t1', 'a.ts', 't1-new comment')]);
    expect(updates).toEqual(['a.ts', 'b.ts']);
    expect(kinds('b.ts')).toEqual([]);
  });

  test("a note is never one of the person's comments: their own edits keep it, and no host means none", async () => {
    await mount([note('t1', 'a.ts')]);
    await draw([note('t1', 'a.ts')], [{ ...mine, text: 'edited' }]);
    expect(kinds('a.ts')).toEqual(['host-note:t1', 'annotation:mine']);
    await act(async () => root?.unmount());
    root = createRoot(host!);
    await draw(undefined);
    expect(kinds('a.ts')).toEqual(['annotation:mine']);
  });
});

const fileNote = (id: string, filePath: string, key = id): HostFileNote => ({ id, filePath, key, render: () => <b data-file-note={id}>{key}</b> });
const mineOnFile: CodeAnnotation = { id: 'mine-file', type: 'comment', scope: 'file', filePath: 'a.ts', lineStart: 0, lineEnd: 0, side: 'new', text: 'my words on the file', createdAt: 2 };
async function header(id: string): Promise<string> {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const slot = createRoot(box);
  await act(async () => slot.render(<>{renderCustomHeader(items.get(id)!)}</>));
  const markup = box.innerHTML.replace(/base-ui-[^"]+/g, 'id');
  await act(async () => slot.unmount());
  box.remove();
  return markup;
}
const fileNotesIn = (markup: string) => [...markup.matchAll(/data-file-note="([^"]+)"/g)].map((m) => m[1]);

describe.if(hasDom)("the host's notes on whole files", () => {
  test("under the file's header in the order given, above the person's own comment on the file; never on a line", async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await draw([], [mine, mineOnFile], [fileNote('w1', 'a.ts'), fileNote('w2', 'a.ts')]);
    const a = await header('a.ts');
    expect(fileNotesIn(a)).toEqual(['w1', 'w2']);
    expect(a.indexOf('data-file-note="w2"')).toBeLessThan(a.indexOf('my words on the file'));
    expect(fileNotesIn(await header('b.ts'))).toEqual([]);
    expect(kinds('a.ts')).toEqual(['annotation:mine']);
  });

  test('notes that come later draw only their file again; the same keys draw nothing; a gone note leaves its header', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await draw([], [mine], []);
    await draw([], [mine], [fileNote('w1', 'b.ts')]);
    expect(updates).toEqual(['b.ts']);
    expect(fileNotesIn(await header('b.ts'))).toEqual(['w1']);
    await draw([], [mine], [fileNote('w1', 'b.ts')]);
    expect(updates).toEqual(['b.ts']);
    await draw([], [mine], [fileNote('w1', 'b.ts', 'w1-new comment')]);
    expect(updates).toEqual(['b.ts', 'b.ts']);
    expect(await header('b.ts')).toContain('w1-new comment');
    await draw([], [mine], []);
    expect(updates).toEqual(['b.ts', 'b.ts', 'b.ts']);
    expect(fileNotesIn(await header('b.ts'))).toEqual([]);
  });

  test('a host that passes none: the headers are as before', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await draw(undefined, [mine]);
    const before = await header('a.ts');
    expect(before).not.toContain('data-host-file-note');
    await act(async () => root?.unmount());
    root = createRoot(host!);
    await draw(undefined, [mine], []);
    expect(await header('a.ts')).toBe(before);
  });
});

describe.if(hasDom)("a file note's known height", () => {
  test('a view of one file sizes its header for its notes from the start; files that differ, or a height not given, leave it measured', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const sized = (id: string, filePath: string, height?: number): HostFileNote => ({ ...fileNote(id, filePath), ...(height === undefined ? {} : { height }) });
    await draw([], [mine], [], [files[0]!]);
    const bare = viewOptions.itemMetrics!.diffHeaderHeight!;
    await draw([], [mine], [sized('w1', 'a.ts', 32), sized('w2', 'a.ts', 32)], [files[0]!]);
    expect(viewOptions.itemMetrics!.diffHeaderHeight).toBe(bare + 64);
    await draw([], [mine], [sized('w1', 'a.ts', 32)], files);
    expect(viewOptions.itemMetrics!.diffHeaderHeight).toBe(bare);
    await draw([], [mine], [sized('w1', 'a.ts')], [files[0]!]);
    expect(viewOptions.itemMetrics!.diffHeaderHeight).toBe(bare);
  });
});
