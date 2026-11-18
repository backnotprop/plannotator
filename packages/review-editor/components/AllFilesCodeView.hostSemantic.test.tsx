import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import type { DiffFile } from '../types';
import type { SemDiffClient, SemDiffResult } from '../semDiff/semDiffClient';

let lastCodeViewProps: Record<string, unknown> | null = null;
let items = new Map<string, { id: string; type: string; fileDiff: Record<string, unknown>; version?: number }>();

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
    name: patch.match(/\+\+\+ b\/(\S+)/)?.[1] ?? 'file.ts',
    type: 'change',
    hunks: [],
    splitLineCount: 1,
    unifiedLineCount: 1,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  }),
  processFile: (patch: string) => ({ name: 'whole', type: 'change', hunks: [], splitLineCount: 2, unifiedLineCount: 2, isPartial: false, deletionLines: [], additionLines: [], patch }),
}));

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Array<{ id: string; type: string; fileDiff: Record<string, unknown> }>; className?: string; containerRef?: React.Ref<HTMLDivElement> },
    ref: React.ForwardedRef<unknown>,
  ) {
    const seeded = useRef(false);
    if (!seeded.current) {
      seeded.current = true;
      items = new Map((props.initialItems ?? []).map((item) => [item.id, item]));
    }
    lastCodeViewProps = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => items.get(id),
      updateItem: (item: { id: string; type: string; fileDiff: Record<string, unknown> }) => {
        items.set(item.id, item);
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
const headerRoots: Root[] = [];

function changed(path: string): DiffFile {
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-old\n+new\n same`,
    additions: 1,
    deletions: 1,
    status: 'modified',
  };
}

const moved: SemDiffResult = {
  semanticOperations: [{ type: 'moved', lines: { old: [{ start: 1, end: 1 }], new: [{ start: 2, end: 2 }] } } as never],
  semanticFolds: [],
  patch: 'semantic patch',
  summary: { counts: { moved: 1 } } as never,
};

function fakeClient(answer: SemDiffResult | null, supported = (path: string) => path.endsWith('.ts')) {
  const asked: string[] = [];
  const client: SemDiffClient = {
    supports: supported,
    diff: async (path) => {
      asked.push(path);
      return answer;
    },
    attempt: async () => ({ result: answer, failed: false }),
    dispose: () => {},
  };
  return { client, asked };
}

function hostReader(texts: { oldContent: string; newContent: string } = { oldContent: 'old\nsame\n', newContent: 'new\nsame\n' }) {
  const reads: string[] = [];
  const read = async (file: DiffFile) => {
    reads.push(file.path);
    return texts;
  };
  return { read, reads };
}

async function mount(files: DiffFile[], props: Partial<React.ComponentProps<typeof AllFilesCodeView>>, settleMs = 260) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AllFilesCodeView
        files={files}
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
        readOnly
        contextExpansionAvailable={false}
        {...props}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  const options = lastCodeViewProps?.options as { onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: unknown) => void };
  await act(async () => {
    for (const item of items.values()) {
      options.onPostRender(document.createElement('div'), {}, 'mount', { item });
      options.onPostRender(document.createElement('div'), {}, 'update', { item });
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  });
}

async function headerOf(path: string): Promise<HTMLElement> {
  const item = [...items.values()].find((candidate) => candidate.id.includes(path))!;
  const render = lastCodeViewProps?.renderCustomHeader as (item: unknown) => React.ReactNode;
  const box = document.createElement('div');
  document.body.appendChild(box);
  const headerRoot = createRoot(box);
  headerRoots.push(headerRoot);
  await act(async () => headerRoot.render(<>{render(item)}</>));
  return box;
}

afterEach(async () => {
  configStore.set('diffSemantic', true);
  for (const headerRoot of headerRoots.splice(0)) await act(async () => headerRoot.unmount());
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  lastCodeViewProps = null;
  items = new Map();
});

afterAll(() => {
  mock.module('@pierre/diffs', () => realPierreDiffs);
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe('AllFilesCodeView semantic diffs through a host reader', () => {
  test.skipIf(!hasDom)('a read-only host with a client reads each file once and its header says what moved', async () => {
    const { client, asked } = fakeClient(moved);
    const { read, reads } = hostReader();
    await mount([changed('a.ts'), changed('b.ts')], { semDiffClient: client, fetchFileContent: read });

    expect(reads.sort()).toEqual(['a.ts', 'b.ts']);
    expect(asked.sort()).toEqual(['a.ts', 'b.ts']);
    expect([...items.values()].every((item) => item.fileDiff.isPartial === false)).toBe(true);
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note="semantic"]')?.textContent).toContain('1 moved');
  });

  test.skipIf(!hasDom)('nothing to say, an unsupported file or texts that do not fit the patch: no note, the plain diff', async () => {
    const quiet = fakeClient(null);
    const quietRead = hostReader();
    await mount([changed('a.ts')], { semDiffClient: quiet.client, fetchFileContent: quietRead.read });
    expect(quietRead.reads).toEqual(['a.ts']);
    expect([...items.values()][0]!.fileDiff.isPartial).toBe(true);
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note]')).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    const unsupported = fakeClient(moved);
    const unsupportedRead = hostReader();
    await mount([changed('notes.txt')], { semDiffClient: unsupported.client, fetchFileContent: unsupportedRead.read });
    expect(unsupportedRead.reads).toEqual([]);
    expect(unsupported.asked).toEqual([]);

    await act(async () => root?.unmount());
    root = null;
    const stale = fakeClient(moved);
    const staleRead = hostReader({ oldContent: 'old\nsame\n', newContent: 'new\nsame\nadded later\n' });
    await mount([changed('a.ts')], { semDiffClient: stale.client, fetchFileContent: staleRead.read });
    expect(staleRead.reads).toEqual(['a.ts']);
    expect(stale.asked).toEqual([]);
    expect([...items.values()][0]!.fileDiff.isPartial).toBe(true);
  });

  test.skipIf(!hasDom)('semantic diffs saved off: a host with a client reads nothing on mount', async () => {
    configStore.set('diffSemantic', false);
    const { client, asked } = fakeClient(moved);
    const { read, reads } = hostReader();
    await mount([changed('a.ts'), changed('b.ts')], { semDiffClient: client, fetchFileContent: read });
    expect(reads).toEqual([]);
    expect(asked).toEqual([]);
  });

  test.skipIf(!hasDom)('an arrow opened while the first read is on its way brings the file its note, offered, with the opened lines left where they are', async () => {
    const { client, asked } = fakeClient(moved);
    const texts = { oldContent: 'old\nsame\n', newContent: 'new\nsame\n' };
    let calls = 0;
    const read = (_file: DiffFile, signal?: AbortSignal) => {
      calls++;
      if (calls === 1) return new Promise<typeof texts>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return Promise.resolve(texts);
    };
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read });
    const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
    await act(async () => {
      await options.loadDiffFiles({ name: 'a.ts' });
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    expect(calls).toBe(2);
    expect(asked).toEqual(['a.ts']);
    expect([...items.values()][0]!.fileDiff.semanticOperations).toBeUndefined();
    const offered = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note="off"]');
    expect(offered?.textContent).toContain('1 moved');
    await act(async () => offered!.click());
    expect(([...items.values()][0]!.fileDiff.semanticOperations as unknown[] | undefined)?.length).toBe(1);
  });

  test.skipIf(!hasDom)('a moved block holding a comment draws open, one with none stays folded, and a comment arriving later opens its fold', async () => {
    const folded: SemDiffResult = { ...moved, semanticFolds: [{ old: { start: 1, end: 1 }, operations: [0], counts: { moved: 1, edited: 0, removed: 0 } }] as never };
    const { client } = fakeClient(folded);
    const { read } = hostReader();
    const comment = (filePath: string) => ({ id: `c-${filePath}`, type: 'comment', filePath, lineStart: 1, lineEnd: 1, side: 'old', text: 'Why move it?', createdAt: 0 }) as unknown as React.ComponentProps<typeof AllFilesCodeView>['annotations'][number];
    const files = [changed('a.ts'), changed('b.ts')];
    await mount(files, { semDiffClient: client, fetchFileContent: read, annotations: [comment('a.ts')] });
    const folds = (path: string) => ([...items.values()].find((item) => item.id.includes(path))!.fileDiff as { semanticFolds?: unknown[] }).semanticFolds?.length ?? 0;
    const drawn = (path: string) => (([...items.values()].find((item) => item.id.includes(path)) as { annotations?: Array<{ lineNumber: number; side: string }> }).annotations ?? []).some((a) => a.side === 'deletions' && a.lineNumber === 1);
    expect([folds('a.ts'), drawn('a.ts')]).toEqual([0, true]);
    expect([folds('b.ts'), drawn('b.ts')]).toEqual([1, false]);

    await act(async () => {
      root!.render(
        <AllFilesCodeView files={files} diffStyle="unified" annotations={[comment('a.ts'), comment('b.ts')]} selectedAnnotationId={null} scrollTargetAnnotation={null} pendingSelection={null} onLineSelection={() => {}} onAddAnnotationForFile={() => {}} onEditAnnotation={() => {}} onSelectAnnotation={() => {}} onDeleteAnnotation={() => {}} readOnly contextExpansionAvailable={false} semDiffClient={client} fetchFileContent={read} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect([folds('b.ts'), drawn('b.ts')]).toEqual([0, true]);
  });

  test.skipIf(!hasDom)('an arrow loaded twice before the note (a hover, then the click) ends with the header offering the semantic view, and one click shows it', async () => {
    const asked: string[] = [];
    const client: SemDiffClient = {
      supports: (path) => path.endsWith('.ts'),
      diff: async (path) => {
        asked.push(path);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return moved;
      },
      attempt: async () => ({ result: moved, failed: false }),
      dispose: () => {},
    };
    const texts = { oldContent: 'old\nsame\n', newContent: 'new\nsame\n' };
    const read = (_file: DiffFile, signal?: AbortSignal, how?: { background?: boolean }) =>
      how?.background ? new Promise<typeof texts>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) : Promise.resolve(texts);
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read });
    const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
    await act(async () => {
      await options.loadDiffFiles({ name: 'a.ts' });
      await options.loadDiffFiles({ name: 'a.ts' });
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const offered = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note]');
    expect([offered?.dataset.semanticNote, offered?.textContent?.includes('1 moved')]).toEqual(['off', true]);
    await act(async () => offered!.click());
    expect(([...items.values()][0]!.fileDiff.semanticOperations as unknown[] | undefined)?.length).toBe(1);
  });

  test.skipIf(!hasDom)('a client arriving after an arrow read the file still brings the file its note', async () => {
    const { client } = fakeClient(moved);
    const { read } = hostReader();
    const files = [changed('a.ts')];
    await mount(files, { fetchFileContent: read });
    const first = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
    await act(async () => {
      await first.loadDiffFiles({ name: 'a.ts' });
    });
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note]')).toBeNull();
    await act(async () => {
      root!.render(
        <AllFilesCodeView files={files} diffStyle="unified" annotations={[]} selectedAnnotationId={null} scrollTargetAnnotation={null} pendingSelection={null} onLineSelection={() => {}} onAddAnnotationForFile={() => {}} onEditAnnotation={() => {}} onSelectAnnotation={() => {}} onDeleteAnnotation={() => {}} readOnly contextExpansionAvailable={false} semDiffClient={client} fetchFileContent={read} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const options = lastCodeViewProps?.options as { onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: unknown) => void };
    await act(async () => {
      for (const item of items.values()) options.onPostRender(document.createElement('div'), {}, 'mount', { item });
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const note = (await headerOf('a.ts')).querySelector<HTMLElement>('[data-semantic-note]');
    expect([note?.dataset.semanticNote === 'working', note?.textContent?.includes('1 moved')]).toEqual([false, true]);
  });

  for (const [when, engineMs, settleMs] of [['before the engine answers', 400, 40], ['while its answer waits to be drawn', 20, 80]] as const) {
    test.skipIf(!hasDom)(`an arrow loaded after the first read landed, ${when}: the header ends offering the note, never reading and never blank`, async () => {
      const client: SemDiffClient = {
        supports: (path) => path.endsWith('.ts'),
        diff: async () => {
          await new Promise((resolve) => setTimeout(resolve, engineMs));
          return moved;
        },
        attempt: async () => ({ result: moved, failed: false }),
        dispose: () => {},
      };
      const { read } = hostReader();
      await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read }, settleMs);
      const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
      await act(async () => {
        await options.loadDiffFiles({ name: 'a.ts' });
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const offered = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note]');
      expect([offered?.dataset.semanticNote, offered?.textContent?.includes('1 moved')]).toEqual(['off', true]);
      await act(async () => offered!.click());
      expect(([...items.values()][0]!.fileDiff.semanticOperations as unknown[] | undefined)?.length).toBe(1);
    });
  }

  test.skipIf(!hasDom)('a host that passes no client reads nothing on mount', async () => {
    const { read, reads } = hostReader();
    await mount([changed('a.ts'), changed('b.ts')], { fetchFileContent: read });
    expect(reads).toEqual([]);
  });
});
