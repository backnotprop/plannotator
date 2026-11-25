/**
 * A diff that fails while a "+" selection is set comes back on Try again (AllFilesCodeView's RegionBoundary), and the
 * words typed in the comment box are there when the box opens on those lines again.
 *
 * The selection a "+" sets is the host's (the review app keeps `pendingSelection` above the diff's boundary). Drawn
 * again with it, the diff would fail again, so Try again clears it first (`onRetry` → the host's `onLineSelection(null)`).
 * The typed words are not in it: the toolbar's draft store keeps them by file and lines across the remount.
 *
 * What regresses if this fails: Try again on a diff that failed under a "+" fails again, every time, until a reload;
 * or the remount loses what was typed in the comment box.
 *
 * CodeView is a stand-in that throws while it is handed a selection and `poison.on` is set (the reported Firefox
 * crash came from a "+" press); the toolbar and its comment box are the real ones.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { catchRenderErrorsInTests } from '@plannotator/ui/components/RegionBoundary';
import type { DiffFile } from '../types';
import type { AllFilesCodeViewProps } from './AllFilesCodeView';

/** The range the view hands its host's `onLineSelection`. */
type SelectedLineRange = NonNullable<Parameters<AllFilesCodeViewProps['onLineSelection']>[0]>;

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

type Item = { id: string; type: 'diff'; version?: number; annotations: unknown[]; fileDiff: unknown };
type Options = { onGutterUtilityClick?: (range: SelectedLineRange, context: { item: Item }) => void };
let items = new Map<string, Item>();
let options: Options = {};
/** While set, the stand-in CodeView throws when it is handed a selection. */
const poison = { on: false };

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Item[]; containerRef?: React.Ref<HTMLDivElement>; className?: string; options: Options; selectedLines?: unknown },
    ref: React.ForwardedRef<unknown>,
  ) {
    const seeded = useRef(false);
    if (!seeded.current) {
      seeded.current = true;
      items = new Map((props.initialItems ?? []).map((item) => [item.id, { ...item }]));
    }
    options = props.options;
    if (poison.on && props.selectedLines != null) throw new TypeError('can\'t access property "side", range is undefined');
    useImperativeHandle(ref, () => ({
      addItems: () => {},
      getItem: (id: string) => items.get(id),
      updateItem: (item: Item) => {
        items.set(item.id, { ...item });
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

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
const roots: { root: Root; box: HTMLElement }[] = [];
const restores: Array<() => void> = [];

const file: DiffFile = {
  path: 'Sources/Harbor/Berth.swift',
  patch: 'diff --git a/Sources/Harbor/Berth.swift b/Sources/Harbor/Berth.swift\n--- a/Sources/Harbor/Berth.swift\n+++ b/Sources/Harbor/Berth.swift\n@@ -1,3 +1,3 @@\n struct Berth {\n-  let slot = 1\n+  let slot = 2\n }\n',
  additions: 1,
  deletions: 1,
  status: 'modified',
};
const LINE: SelectedLineRange = { start: 2, end: 2, side: 'additions' };
const WORDS = 'Ada Novak: slot 2 is the one the ferry uses.';

/** The review app's side: the selection the "+" sets is kept here, above the diff's boundary. */
let redraw: () => void = () => {};
let selections: (SelectedLineRange | null)[] = [];
function Host() {
  const [pending, setPending] = useState<SelectedLineRange | null>(null);
  const [, tick] = useState(0);
  redraw = () => tick((n) => n + 1);
  return (
    <AllFilesCodeView
      files={[file]}
      diffStyle="unified"
      annotations={[]}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={pending}
      onLineSelection={(range) => {
        selections.push(range);
        setPending(range);
      }}
      onAddAnnotationForFile={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
      scrollsWithPage
    />
  );
}

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<HTMLElement> {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  roots.push({ root, box });
  await act(async () => root.render(<Host />));
  await settle();
  return box;
}

/** The "+" on the line, as CodeView reports it. */
async function plus() {
  await act(async () => options.onGutterUtilityClick!(LINE, { item: items.get(file.path)! }));
  await settle();
}

function commentBox(): HTMLTextAreaElement | null {
  return document.body.querySelector<HTMLTextAreaElement>('textarea');
}

async function type(field: HTMLTextAreaElement, text: string) {
  const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setText.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(async () => {
  for (const { root, box } of roots.splice(0)) {
    await act(async () => root.unmount());
    box.remove();
  }
  items = new Map();
  options = {};
  poison.on = false;
  selections = [];
  while (restores.length > 0) restores.pop()!();
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)('a diff that failed under a "+" comes back on Try again (DOM)', () => {
  test('Try again clears the selection that failed it, and the comment box opens again with the words typed', async () => {
    restores.push(catchRenderErrorsInTests());
    const error = console.error;
    console.error = () => {};
    restores.push(() => {
      console.error = error;
    });
    const box = await mount();
    await plus();
    const field = commentBox();
    expect(field).not.toBeNull();
    await type(field!, WORDS);

    // The diff draws again while the selection is set, and fails: the notice in its place.
    poison.on = true;
    await act(async () => redraw());
    await settle();
    expect(box.querySelector('[data-region-failed="Diff"]')).not.toBeNull();
    expect(commentBox()).toBeNull();

    // Try again: the host's selection is cleared first, so the diff draws, even with the fault still there.
    await act(async () => box.querySelector<HTMLButtonElement>('[data-region-try-again]')!.click());
    await settle();
    expect(box.querySelector('[data-region-failed]')).toBeNull();
    expect(selections.at(-1)).toBeNull();

    // The "+" on the same line again (the fault fixed): the box holds what was typed.
    poison.on = false;
    await plus();
    expect(commentBox()?.value).toBe(WORDS);
  });
});
