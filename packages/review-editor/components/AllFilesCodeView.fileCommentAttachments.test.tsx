/**
 * The file's comment box in the all-files view (each file header's Comment button; code review's guided review
 * draws the same view) keeps what it attached. What regresses: Save hands the review only the words, and the
 * pictures and files the box showed are gone; or the file's saved comment, drawn in the header's slot, no longer
 * shows them.
 *
 * CodeView is a stand-in that keeps the items it is given; `renderCustomHeader` is the real one AllFilesCodeView
 * hands it, drawn into the DOM here. The attachments are put in the box the way a closed box keeps them
 * (`restoreCommentDraft` under the box's `draftKey`), so no upload runs.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';
import { restoreCommentDraft } from '@plannotator/ui/components/CommentPopover';
import type { DiffFile } from '../types';

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
let items = new Map<string, Item>();
let renderCustomHeader: (item: Item) => React.ReactNode = () => null;

mock.module('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(function MockCodeView(
    props: { initialItems?: Item[]; containerRef?: React.Ref<HTMLDivElement>; className?: string; renderCustomHeader: typeof renderCustomHeader },
    ref: React.ForwardedRef<unknown>,
  ) {
    const seeded = useRef(false);
    if (!seeded.current) {
      seeded.current = true;
      items = new Map((props.initialItems ?? []).map((item) => [item.id, { ...item }]));
    }
    renderCustomHeader = props.renderCustomHeader;
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

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(_props, ref) {
    useImperativeHandle(ref, () => ({ handleLineSelectionEnd: () => {}, openLineAnnotation: () => {}, handleTokenClick: () => {}, startEdit: () => {} }));
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
const roots: { root: Root; box: HTMLElement }[] = [];

const file: DiffFile = {
  path: 'src/harvest.ts',
  patch: 'diff --git a/src/harvest.ts b/src/harvest.ts\n--- a/src/harvest.ts\n+++ b/src/harvest.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
  additions: 1,
  deletions: 1,
  status: 'modified',
};
const picture: ImageAttachment = { path: '/tmp/plannotator/upload-1/shed-roof.png', name: 'shed-roof' };
const logFile: ImageAttachment = { path: '/tmp/plannotator/upload-2/harvest.log', name: 'harvest.log', kind: 'file' };

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  roots.push({ root, box });
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return box;
}

function view(props: Partial<React.ComponentProps<typeof AllFilesCodeView>>) {
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
      scrollsWithPage
      {...props}
    />
  );
}

afterEach(async () => {
  for (const { root, box } of roots.splice(0)) {
    await act(async () => root.unmount());
    box.remove();
  }
  items = new Map();
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

describe.if(hasDom)("the all-files view's file comment box keeps its attachments (DOM)", () => {
  test('Save hands the review the file, the words and both attachments', async () => {
    restoreCommentDraft('file:::src/harvest.ts', 'Bob Tully: the log shows the late crate.', [picture, logFile]);
    const added: { filePath: string; text: string; images?: ImageAttachment[] }[] = [];
    await mount(view({ onAddFileCommentForFile: (filePath, text, images) => { added.push({ filePath, text, images }); } }));
    const header = await mount(<>{renderCustomHeader(items.get('src/harvest.ts')!)}</>);

    const commentButton = header.querySelector<HTMLButtonElement>('button[aria-label="Comment on this file"]');
    expect(commentButton).not.toBeNull();
    await act(async () => commentButton!.click());
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Save' && !b.disabled);
    expect(save).toBeDefined();
    await act(async () => save!.click());

    expect(added).toEqual([{ filePath: 'src/harvest.ts', text: 'Bob Tully: the log shows the late crate.', images: [picture, logFile] }]);
  });

  test("the file's saved comment shows its picture and its file in the header's slot", async () => {
    const saved: CodeAnnotation = {
      id: 'c1', type: 'comment', scope: 'file', filePath: 'src/harvest.ts', lineStart: 1, lineEnd: 1, side: 'new',
      images: [picture, logFile], createdAt: 1,
    };
    await mount(view({ annotations: [saved] }));
    const header = await mount(<>{renderCustomHeader(items.get('src/harvest.ts')!)}</>);
    const names = Array.from(header.querySelectorAll('[data-annotation-id="c1"] [data-file-comment-attachments] [title]')).map((n) => n.getAttribute('title'));
    expect(names).toEqual(['shed-roof', 'harvest.log']);
  });
});
