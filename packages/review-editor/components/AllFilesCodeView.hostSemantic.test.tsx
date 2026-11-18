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

let renderedItems: unknown[] = [];

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
        getRenderedItems: () => renderedItems,
        getScrollTop: () => 0,
        getScrollHeight: () => 0,
        getHeight: () => 0,
        getTopForItem: () => 0,
        scrollTo: () => {},
      }),
    }));
    return <div ref={props.containerRef} className={props.className} data-mock-scroll="" />;
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

const touchAt = (type: string, x: number) => Object.assign(new Event(type, { bubbles: true, composed: true }), { changedTouches: [{ clientX: x, clientY: 0 }] });

async function pressArrow(gesture: string | Event[] = 'click', marker = 'data-expand-button') {
  const options = lastCodeViewProps?.options as { onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: unknown) => void };
  const container = document.createElement('diffs-container');
  const arrow = document.createElement('div');
  arrow.setAttribute(marker, '');
  container.appendChild(arrow);
  document.querySelector('[data-mock-scroll]')!.appendChild(container);
  await act(async () => {
    options.onPostRender(container, {}, 'update', { item: [...items.values()][0] });
    for (const event of typeof gesture === 'string' ? [new Event(gesture, { bubbles: true, composed: true })] : gesture) arrow.dispatchEvent(event);
  });
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
  renderedItems = [];
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
    await pressArrow();
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
    await pressArrow();
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
      await pressArrow();
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

  for (const [gesture, shown] of [
    ['pointermove', 'semantic'],
    ['pointerdown', 'off'],
    ['click', 'off'],
    ['Enter', 'off'],
    ['touch that scrolls', 'off'],
    ['tap', 'off'],
  ] as const) {
    test.skipIf(!hasDom)(`an arrow met by ${gesture} before the note arrives: the note ends ${shown === 'semantic' ? 'shown by itself' : 'offered, the opened lines left alone'}`, async () => {
      const client: SemDiffClient = {
        supports: (path) => path.endsWith('.ts'),
        diff: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return moved;
        },
        attempt: async () => ({ result: moved, failed: false }),
        dispose: () => {},
      };
      const { read } = hostReader();
      const realRect = Element.prototype.getBoundingClientRect;
      const realSizes = (['scrollHeight', 'clientHeight'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
      Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 800, width: 800, top: 0, bottom: 700, height: 700, toJSON: () => ({}) }) as DOMRect;
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 3000 });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
      try {
        await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read }, 40);
        await pressArrow(
          gesture === 'Enter'
            ? [Object.assign(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }))]
            : gesture === 'touch that scrolls'
              ? [touchAt('touchstart', 0), touchAt('touchend', 60)]
              : gesture === 'tap'
                ? [touchAt('touchstart', 0), touchAt('touchend', 2)]
                : gesture,
        );
        const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
        await act(async () => {
          await options.loadDiffFiles({ name: 'a.ts' });
          await new Promise((resolve) => setTimeout(resolve, 600));
        });
        expect((await headerOf('a.ts')).querySelector<HTMLElement>('[data-semantic-note]')?.dataset.semanticNote).toBe(shown);
      } finally {
        Element.prototype.getBoundingClientRect = realRect;
        for (const [name, real] of realSizes) {
          if (real) Object.defineProperty(HTMLElement.prototype, name, real);
          else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        }
      }
    });
  }

  test.skipIf(!hasDom)('the switch turned off takes every semantic note out of the headers at once', async () => {
    const { client } = fakeClient(moved);
    const { read } = hostReader();
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read });
    expect((await headerOf('a.ts')).querySelector<HTMLElement>('[data-semantic-note]')?.dataset.semanticNote).toBe('semantic');
    await act(async () => configStore.set('diffSemantic', false));
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note]')).toBeNull();
  });

  test.skipIf(!hasDom)('files drawn while the switch was off get their notes when it is turned on', async () => {
    configStore.set('diffSemantic', false);
    const { client } = fakeClient(moved);
    const { read, reads } = hostReader();
    await mount([changed('a.ts'), changed('b.ts')], { semDiffClient: client, fetchFileContent: read });
    expect(reads).toEqual([]);
    await act(async () => {
      configStore.set('diffSemantic', true);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(reads.sort()).toEqual(['a.ts', 'b.ts']);
    for (const path of ['a.ts', 'b.ts']) expect((await headerOf(path)).querySelector<HTMLElement>('[data-semantic-note]')?.dataset.semanticNote).toBe('semantic');
  });

  test.skipIf(!hasDom)('a first-draw run still out when an arrow loads and the view unmounts: nothing is asked after unmount', async () => {
    let gone = false;
    const late: string[] = [];
    const client: SemDiffClient = {
      supports: (path) => path.endsWith('.ts'),
      diff: async (path, _old, _new, signal) => {
        if (gone) late.push(path);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return signal?.aborted ? null : moved;
      },
      attempt: async () => ({ result: moved, failed: false }),
      dispose: () => {},
    };
    const { read } = hostReader();
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read, powerUp: { active: true, rejected: [], provider: 'jev', retry: 0 } }, 40);
    await pressArrow();
    const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
    await act(async () => {
      await options.loadDiffFiles({ name: 'a.ts' });
    });
    await act(async () => root?.unmount());
    root = null;
    gone = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(late).toEqual([]);
  });

  test.skipIf(!hasDom)('a comment over several old lines that starts inside a moved block and ends past it opens that block', async () => {
    const folded: SemDiffResult = { ...moved, semanticFolds: [{ old: { start: 1, end: 2 }, operations: [0], counts: { moved: 2, edited: 0, removed: 0 } }] as never };
    const { client } = fakeClient(folded);
    const { read } = hostReader();
    const comment = { id: 'span', type: 'comment', filePath: 'a.ts', lineStart: 2, lineEnd: 4, side: 'old', text: 'These go together.', createdAt: 0 } as unknown as React.ComponentProps<typeof AllFilesCodeView>['annotations'][number];
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read, annotations: [comment] });
    expect(([...items.values()][0]!.fileDiff as { semanticFolds?: unknown[] }).semanticFolds?.length ?? 0).toBe(0);
  });

  test.skipIf(!hasDom)('a tap whose arrow row is redrawn before the finger lifts still counts: the click opens the lines and the note is offered', async () => {
    const client: SemDiffClient = {
      supports: (path) => path.endsWith('.ts'),
      diff: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return moved;
      },
      attempt: async () => ({ result: moved, failed: false }),
      dispose: () => {},
    };
    const { read } = hostReader();
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read }, 40);
    const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown>; onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: unknown) => void };
    const container = document.createElement('diffs-container');
    const before = document.createElement('div');
    before.setAttribute('data-expand-button', '');
    container.appendChild(before);
    document.querySelector('[data-mock-scroll]')!.appendChild(container);
    await act(async () => {
      options.onPostRender(container, {}, 'update', { item: [...items.values()][0] });
      before.dispatchEvent(touchAt('touchstart', 0));
      await options.loadDiffFiles({ name: 'a.ts' });
      before.remove();
      const after = document.createElement('div');
      after.setAttribute('data-expand-button', '');
      container.appendChild(after);
      after.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect((await headerOf('a.ts')).querySelector<HTMLElement>('[data-semantic-note]')?.dataset.semanticNote).toBe('off');
  });

  for (const [gesture, shown] of [['pointermove', 'semantic'], ['click', 'off']] as const) {
    test.skipIf(!hasDom)(`the unmodified-lines label met by ${gesture} before the note arrives: the note ends ${shown === 'off' ? 'offered, the opened lines left alone' : 'shown by itself'}`, async () => {
      const client: SemDiffClient = {
        supports: (path) => path.endsWith('.ts'),
        diff: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return moved;
        },
        attempt: async () => ({ result: moved, failed: false }),
        dispose: () => {},
      };
      const { read } = hostReader();
      await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read }, 40);
      await pressArrow(gesture, 'data-unmodified-lines');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect((await headerOf('a.ts')).querySelector<HTMLElement>('[data-semantic-note]')?.dataset.semanticNote).toBe(shown);
    });
  }

  test.skipIf(!hasDom)('with the switch off, the pointer over an arrow or its label reads nothing', async () => {
    configStore.set('diffSemantic', false);
    const { client } = fakeClient(moved);
    const { read, reads } = hostReader();
    await mount([changed('a.ts')], { semDiffClient: client, fetchFileContent: read }, 40);
    const options = lastCodeViewProps?.options as { loadDiffFiles: (fileDiff: { name: string }) => Promise<unknown> };
    const [item] = [...items.values()];
    renderedItems = [{ id: item!.id, type: 'diff', item: { fileDiff: { ...item!.fileDiff, isPartial: true } }, instance: { expandHunk: () => void options.loadDiffFiles({ name: 'a.ts' }) } }];
    await pressArrow('pointermove');
    await pressArrow('pointermove', 'data-unmodified-lines');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(reads).toEqual([]);
  });

  test.skipIf(!hasDom)('a host that passes no client reads nothing on mount', async () => {
    const { read, reads } = hostReader();
    await mount([changed('a.ts'), changed('b.ts')], { fetchFileContent: read });
    expect(reads).toEqual([]);
  });
});

describe('AllFilesCodeView semantic notes that land after the person started reading', () => {
  const box = (top: number, height: number) => ({ x: 0, y: top, left: 0, right: 800, width: 800, top, bottom: top + height, height, toJSON: () => ({}) }) as DOMRect;
  const tops = new Map<Element, number>();
  let pageHeight = 10_000;
  let hidden = false;
  const sizes = ['scrollHeight', 'clientHeight'] as const;
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    tops.clear();
    pageHeight = 10_000;
    hidden = false;
  });

  async function reading(files: string[], at: Record<string, number>, extra: Partial<React.ComponentProps<typeof AllFilesCodeView>> = {}, secondOpinions: SemDiffResult[] = []) {
    if (!restore) {
      const realRect = Element.prototype.getBoundingClientRect;
      const realSizes = sizes.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      restore = () => {
        Element.prototype.getBoundingClientRect = realRect;
        sizes.forEach((name, index) => {
          if (realSizes[index]) Object.defineProperty(HTMLElement.prototype, name, realSizes[index]);
          else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
        });
      };
    }
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return hidden ? box(0, 0) : box(tops.get(this) ?? 0, tops.has(this) ? 400 : 700);
    };
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => pageHeight });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
    const gates: (() => void)[] = [];
    let asked = 0;
    const client: SemDiffClient = {
      supports: (path) => path.endsWith('.ts'),
      diff: (_path, _old, _new, _signal, options) =>
        new Promise((resolve) => gates.push(() => resolve(options ? { ...(secondOpinions.shift() ?? moved), secondOpinion: { state: 'ok', links: [{ operationIndex: 0, candidateId: `c${++asked}` }] } as never } : moved))),
      attempt: async () => ({ result: moved, failed: false }),
      dispose: () => {},
    };
    const { read } = hostReader();
    await mount(files.map(changed), { semDiffClient: client, fetchFileContent: read, ...extra });
    const options = lastCodeViewProps?.options as { onPostRender: (node: HTMLElement, instance: unknown, phase: string, context: unknown) => void };
    const nodes = new Map<string, HTMLElement>();
    await act(async () => {
      for (const item of items.values()) {
        const node = document.createElement('div');
        document.body.appendChild(node);
        const path = files.find((file) => item.id.includes(file))!;
        nodes.set(path, node);
        tops.set(node, at[path]!);
        options.onPostRender(node, {}, 'mount', { item });
      }
    });
    const land = async () => {
      await act(async () => {
        for (const open of gates.splice(0)) open();
        await new Promise((resolve) => setTimeout(resolve, 260));
      });
    };
    const swapped = (path: string) => ([...items.values()].find((item) => item.id.includes(path))!.fileDiff.semanticOperations as unknown[] | undefined)?.length === 1;
    const move = (path: string, top: number) => void tops.set(nodes.get(path)!, top);
    const redraw = async () => {
      await act(async () => {
        for (const item of items.values()) options.onPostRender(nodes.get(files.find((file) => item.id.includes(file))!)!, {}, 'update', { item });
      });
    };
    const drawnKey = (path: string) => String([...items.values()].find((item) => item.id.includes(path))!.fileDiff.cacheKey ?? '');
    const rerender = async (props: Partial<React.ComponentProps<typeof AllFilesCodeView>>) => {
      await act(async () => {
        root!.render(
          <AllFilesCodeView files={files.map(changed)} diffStyle="unified" annotations={[]} selectedAnnotationId={null} scrollTargetAnnotation={null} pendingSelection={null} onLineSelection={() => {}} onAddAnnotationForFile={() => {}} onEditAnnotation={() => {}} onSelectAnnotation={() => {}} onDeleteAnnotation={() => {}} readOnly contextExpansionAvailable={false} semDiffClient={client} fetchFileContent={read} {...extra} {...props} />,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    };
    return { land, swapped, move, redraw, drawnKey, rerender };
  }

  test.skipIf(!hasDom)('after a scroll, a file on screen is offered its note and one wholly below swaps by itself; before any, both swap', async () => {
    const quiet = await reading(['a.ts', 'b.ts'], { 'a.ts': 100, 'b.ts': 3000 });
    await quiet.land();
    expect([quiet.swapped('a.ts'), quiet.swapped('b.ts')]).toEqual([true, true]);
    await act(async () => root?.unmount());
    root = null;

    const engaged = await reading(['a.ts', 'b.ts'], { 'a.ts': 100, 'b.ts': 3000 });
    document.dispatchEvent(new Event('wheel'));
    await engaged.land();
    expect([engaged.swapped('a.ts'), engaged.swapped('b.ts')]).toEqual([false, true]);
    const offered = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note="off"]');
    expect([offered?.textContent?.includes('1 moved'), offered?.getAttribute('aria-pressed')]).toEqual([true, 'false']);
    await act(async () => offered!.click());
    expect(engaged.swapped('a.ts')).toBe(true);
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note]')?.getAttribute('aria-pressed')).toBe('true');
  });

  test.skipIf(!hasDom)('a view hidden after the person started reading it keeps its notes as offers, so nothing has moved when it is shown again', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 100 });
    document.dispatchEvent(new Event('wheel'));
    hidden = true;
    await page.land();
    expect(page.swapped('a.ts')).toBe(false);
  });

  test.skipIf(!hasDom)('a hidden view nobody has read yet draws its notes as they land', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 100 });
    hidden = true;
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
  });

  test.skipIf(!hasDom)('during a fling a file a little below the bottom edge counts as on screen', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 800 });
    document.dispatchEvent(new Event('wheel'));
    let top = 0;
    const fling = setInterval(() => {
      top += 40;
      for (const element of document.querySelectorAll('div')) {
        Object.defineProperty(element, 'scrollTop', { configurable: true, value: top });
        element.dispatchEvent(new Event('scroll'));
      }
    }, 8);
    try {
      await page.land();
    } finally {
      clearInterval(fling);
    }
    expect(page.swapped('a.ts')).toBe(false);
  });

  test.skipIf(!hasDom)('at rest, a file a little below the bottom edge takes its note by itself', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 800 });
    document.dispatchEvent(new Event('wheel'));
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
  });

  test.skipIf(!hasDom)('where the file is when its note lands decides, and near the end of the page even a file below is offered', async () => {
    const page = await reading(['a.ts', 'b.ts', 'c.ts'], { 'a.ts': -3000, 'b.ts': 3000, 'c.ts': 3000 });
    document.dispatchEvent(new Event('pointerdown'));
    page.move('b.ts', 200);
    await page.land();
    expect([page.swapped('a.ts'), page.swapped('b.ts'), page.swapped('c.ts')]).toEqual([false, false, true]);
    await act(async () => root?.unmount());
    root = null;

    pageHeight = 1_200;
    const end = await reading(['a.ts'], { 'a.ts': 3000 });
    document.dispatchEvent(new Event('keydown'));
    await end.land();
    expect(end.swapped('a.ts')).toBe(false);
  });

  test.skipIf(!hasDom)('turning the semantic switch on by hand shows the note in every file, on screen or not', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 100 });
    document.dispatchEvent(new Event('touchstart'));
    await page.land();
    expect(page.swapped('a.ts')).toBe(false);
    await act(async () => configStore.set('diffSemantic', false));
    await act(async () => configStore.set('diffSemantic', true));
    expect(page.swapped('a.ts')).toBe(true);
  });

  test.skipIf(!hasDom)('a restored position that leaves the page where it is does not count as the person moving', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 100 }, { initialScrollPosition: 400 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
  });

  const powerUp = { active: true, rejected: [], provider: 'jev', retry: 0 } as never;

  test.skipIf(!hasDom)('a second opinion landing after the switch was turned on by hand is offered, not drawn under the reader', async () => {
    configStore.set('diffSemantic', false);
    const page = await reading(['a.ts'], { 'a.ts': 100 }, { powerUp });
    document.dispatchEvent(new Event('pointerdown'));
    await act(async () => configStore.set('diffSemantic', true));
    await page.redraw();
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
    await page.land();
    expect(page.drawnKey('a.ts')).not.toContain(':c1');
  });

  test.skipIf(!hasDom)('a file drawn semantic whose second opinion is offered keeps saying so, and the next toggle on draws the newer answer', async () => {
    const page = await reading(['a.ts'], { 'a.ts': 100 }, { powerUp });
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
    document.dispatchEvent(new Event('wheel'));
    await page.land();
    expect(page.drawnKey('a.ts')).not.toContain(':c1');
    const shown = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note]');
    expect(shown?.dataset.semanticNote).toBe('semantic');
    await act(async () => shown!.click());
    const off = (await headerOf('a.ts')).querySelector<HTMLButtonElement>('[data-semantic-note]');
    expect(off?.dataset.semanticNote).toBe('off');
    await act(async () => off!.click());
    expect(page.drawnKey('a.ts')).toContain(':c1');
  });

  test.skipIf(!hasDom)('a newer answer drawn by itself brings its own counts to the header, not those of one that was waiting', async () => {
    const summary = (counts: Record<string, number>) => ({ ...moved, summary: { counts } as never });
    const page = await reading(['a.ts'], { 'a.ts': 100 }, { powerUp }, [summary({ moved: 1, renamed: 1 }), summary({ moved: 2 })]);
    await page.land();
    document.dispatchEvent(new Event('wheel'));
    await page.land();
    expect(page.drawnKey('a.ts')).not.toContain(':c1');
    page.move('a.ts', 3000);
    await page.rerender({ powerUp: { active: true, rejected: ['c1'], provider: 'jev', retry: 0 } as never });
    await page.land();
    expect(page.drawnKey('a.ts')).toContain(':c2');
    expect((await headerOf('a.ts')).querySelector('[data-semantic-note]')?.textContent).toBe('2 moved');
  });

  test.skipIf(!hasDom)('notes that land after the switch was turned on by hand show, on screen or not', async () => {
    configStore.set('diffSemantic', false);
    const page = await reading(['a.ts'], { 'a.ts': 100 });
    document.dispatchEvent(new Event('pointerdown'));
    await act(async () => configStore.set('diffSemantic', true));
    await page.redraw();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    document.dispatchEvent(new Event('keydown'));
    await page.land();
    expect(page.swapped('a.ts')).toBe(true);
  });
});
