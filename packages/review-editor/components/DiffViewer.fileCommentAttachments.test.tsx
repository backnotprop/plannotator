/**
 * The file's comment box in the single-file diff (the header's Comment button) keeps what it attached. What
 * regresses: the box shows the paperclip and its tiles, Save hands the review only the words, and the pictures
 * and files are gone; or a saved file comment no longer shows what it carries after a reload.
 *
 * The attachments are put in the box the way a closed box keeps them (`restoreCommentDraft`, the box's own draft
 * store under its `draftKey`), so no upload runs.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';
import { restoreCommentDraft } from '@plannotator/ui/components/CommentPopover';

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

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

const PATCH = [
  'diff --git a/src/harvest.ts b/src/harvest.ts',
  'index 0000000..1111111 100644',
  '--- a/src/harvest.ts',
  '+++ b/src/harvest.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

const picture: ImageAttachment = { path: '/tmp/plannotator/upload-1/shed-roof.png', name: 'shed-roof' };
const logFile: ImageAttachment = { path: '/tmp/plannotator/upload-2/harvest.log', name: 'harvest.log', kind: 'file' };

async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}

describe.if(hasDom)("the single-file diff's file comment box keeps its attachments (DOM)", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function render(props: Partial<React.ComponentProps<typeof DiffViewer>>) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <DiffViewer
          patch={PATCH}
          filePath="src/harvest.ts"
          diffStyle="unified"
          annotations={[]}
          selectedAnnotationId={null}
          scrollTargetAnnotation={null}
          pendingSelection={null}
          onLineSelection={() => {}}
          onAddAnnotation={() => {}}
          onAddFileComment={() => {}}
          onEditAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          onDeleteAnnotation={() => {}}
          {...props}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    return host;
  }

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
  });

  test('Save hands the review the words and both attachments', async () => {
    restoreCommentDraft('file:::src/harvest.ts', 'Charlie Dunn: the roof in this shot leaks.', [picture, logFile]);
    const added: { text: string; images?: ImageAttachment[] }[] = [];
    const el = await render({ onAddFileComment: (text, images) => { added.push({ text, images }); } });

    const commentButton = el.querySelector<HTMLButtonElement>('button[aria-label="Comment on this file"]');
    expect(commentButton).not.toBeNull();
    await act(async () => commentButton!.click());
    const save = await waitFor(() =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Save' && !b.disabled),
    );
    await act(async () => save.click());

    expect(added).toEqual([{ text: 'Charlie Dunn: the roof in this shot leaks.', images: [picture, logFile] }]);
  });

  test('a saved file comment shows its picture and its file (as after a reload)', async () => {
    const saved: CodeAnnotation = {
      id: 'c1', type: 'comment', scope: 'file', filePath: 'src/harvest.ts', lineStart: 1, lineEnd: 1, side: 'new',
      text: 'Ada Novak: see the shot.', images: [picture, logFile], createdAt: 1,
    };
    const el = await render({ annotations: [saved] });
    const card = await waitFor(() => el.querySelector('[data-annotation-id="c1"]'));
    const names = Array.from(card.querySelectorAll('[data-file-comment-attachments] [title]')).map((n) => n.getAttribute('title'));
    expect(names).toEqual(['shed-roof', 'harvest.log']);
    // The picture draws as a picture, the file as a file tile.
    const tiles = Array.from(card.querySelectorAll('[data-file-comment-attachments] > div'));
    expect(tiles.map((tile) => tile.querySelector('[data-attachment-file]') !== null)).toEqual([false, true]);
  });
});
