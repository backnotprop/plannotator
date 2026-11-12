import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { preloadHighlighter } from '@pierre/diffs';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

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

const slotText = (side: 'additions' | 'deletions', line: number) =>
  host!.querySelector(`[slot="annotation-${side}-${line}"]`)?.textContent ?? null;

test.skipIf(!hasDom)('a line comment is drawn at its line, the one there at open and one added after', async () => {
  await preloadHighlighter({ themes: ['pierre-dark', 'pierre-light'], langs: [], preferredHighlighter: 'shiki-js' });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON() {} }) as DOMRect;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const first = comment('c1', 2, 'new', 'Throw a typed error the caller can catch.');
  await render([first]);
  expect(slotText('additions', 2)).toContain('Throw a typed error the caller can catch.');

  await render([first, comment('c2', 2, 'old', 'The old check let an empty string through.')]);
  expect(slotText('deletions', 2)).toContain('The old check let an empty string through.');
  expect(slotText('additions', 2)).toContain('Throw a typed error the caller can catch.');
});
