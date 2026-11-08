/**
 * A line comment in the all-files diff (Pierre's CodeView) is drawn at its line: the one already there when the
 * view opens, and one added afterwards.
 *
 * Rendered with the REAL @pierre/diffs, because the defect it covers lives in the call between CodeView and
 * AllFilesCodeView's `renderAnnotation`. @pierre/diffs 1.6 moved the owning item from the second argument to the
 * third. The prop is method-typed, so a two-argument handler still compiled, got the fileDiff as its item, returned
 * null, and every comment's slot stayed empty (the Inbox e2e caught it on the PR page, the guide's diffs and the
 * review). The mocked CodeView of the other AllFilesCodeView tests cannot see that. happy-dom has no layout, so
 * every element is given an 800 px box and CodeView draws its window.
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run diff-renderer DOM tests (isolated, real @pierre/diffs)" step.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { preloadHighlighter } from '@pierre/diffs';
import { CODE_HIGHLIGHTER } from '@plannotator/core/code-highlighter';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

// workerPool imports a Vite-only `?worker&inline` module bun cannot load. Without a pool, CodeView uses the shared
// highlighter on the main thread.
mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

const hasDom = typeof document !== 'undefined';
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (realRect) HTMLElement.prototype.getBoundingClientRect = realRect;
});

const file: DiffFile = {
  path: 'src/auth.ts',
  patch: [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,3 +1,3 @@',
    ' export function check(token: string) {',
    '-  return token.length > 0;',
    '+  if (!token) throw new Error("no token");',
    '   return true;',
    '',
  ].join('\n'),
  additions: 1,
  deletions: 1,
  status: 'modified',
};

const comment = (id: string, line: number, side: 'old' | 'new', text: string): CodeAnnotation => ({
  id,
  type: 'comment',
  filePath: file.path,
  lineStart: line,
  lineEnd: line,
  side,
  text,
  createdAt: 1,
  scope: 'line',
});

function view(annotations: CodeAnnotation[]) {
  return (
    <AllFilesCodeView
      files={[file]}
      diffStyle="unified"
      annotations={annotations}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={null}
      onLineSelection={() => {}}
      onAddAnnotationForFile={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
    />
  );
}

async function render(annotations: CodeAnnotation[]) {
  await act(async () => {
    root!.render(view(annotations));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

/** The words drawn in the annotation slot for a side and line, or null when there is no such slot. */
const slotText = (side: 'additions' | 'deletions', line: number) =>
  host!.querySelector(`[slot="annotation-${side}-${line}"]`)?.textContent ?? null;

test.skipIf(!hasDom)('a line comment is drawn at its line, the one there at open and one added after', async () => {
  // Loaded up front: without a pool, CodeView waits for the shared highlighter before it draws.
  await preloadHighlighter({ themes: ['pierre-dark', 'pierre-light'], langs: [], preferredHighlighter: CODE_HIGHLIGHTER });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON() {} }) as DOMRect;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const first = comment('c1', 2, 'new', 'Throw a typed error the caller can catch.');
  await render([first]);
  expect(slotText('additions', 2)).toContain('Throw a typed error the caller can catch.');

  // Added after the view opened: it reaches CodeView through updateItem, not the first render.
  await render([first, comment('c2', 2, 'old', 'The old check let an empty string through.')]);
  expect(slotText('deletions', 2)).toContain('The old check let an empty string through.');
  expect(slotText('additions', 2)).toContain('Throw a typed error the caller can catch.');
});
