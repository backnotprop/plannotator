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
  path: 'src/Profile.tsx',
  patch: 'diff --git a/src/Profile.tsx b/src/Profile.tsx\nindex 1111111..2222222 100644\n--- a/src/Profile.tsx\n+++ b/src/Profile.tsx\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n',
  additions: 1,
  deletions: 1,
  status: 'modified',
};

const comment: CodeAnnotation = {
  id: 'c1',
  type: 'comment',
  filePath: file.path,
  lineStart: 2,
  lineEnd: 2,
  side: 'new',
  text: 'Name this.',
  createdAt: 1,
  scope: 'line',
};

async function render(annotations: CodeAnnotation[]) {
  await act(async () => {
    root!.render(
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
        scrollsWithPage
        flushFiles
        fetchFileContent={async () => null}
        onContentHeightChange={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

test.skipIf(!hasDom)('a flush file whose comment is deleted keeps its hidden trailing row in the layout', async () => {
  await preloadHighlighter({ themes: ['pierre-dark', 'pierre-light'], langs: [], preferredHighlighter: 'shiki-js' });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON() {} }) as DOMRect;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await render([comment]);
  await render([]);

  const container = host.querySelector('diffs-container');
  expect(container?.hasAttribute('data-trailing-unread')).toBe(true);
  expect(container!.shadowRoot!.querySelector('[data-separator][data-separator-last]')).not.toBeNull();
  const css = [...container!.shadowRoot!.querySelectorAll('style')].map((element) => element.textContent ?? '').join('\n');
  const rule = /[^{}]*\[data-separator-last\][^{}]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toContain('visibility: hidden');
  expect(rule).not.toContain('display: none');
});
