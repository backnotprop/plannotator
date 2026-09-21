/**
 * A file whose card has no diff in it must SAY so.
 *
 * A patch chunk carrying a binary marker and no hunks renders as an empty
 * body, so the card is a bare header with no counts and no reason. That is
 * what a file dropped by the review size probe looked like (#1167): reviewers
 * saw an empty card and could approve without ever seeing the content.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OVERSIZED_REVIEW_STUB_MARKER } from '@plannotator/shared/diff-paths';

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

// The shape the review core emits for a file it declined to read: rename
// metadata, no hunks. Before the fix a renamed-and-edited file could land here
// purely because its size probe could not find the worktree blob.
const STUB_PATCH = [
  'diff --git a/src/Card.tsx b/src/Panel.tsx',
  'similarity index 94%',
  'rename from src/Card.tsx',
  'rename to src/Panel.tsx',
  'index bab081fdb737..99fffbd3cac3 100644',
  'Binary files a/src/Card.tsx and b/src/Panel.tsx differ',
  '',
].join('\n');

const REAL_BINARY = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111111aa..2222222222bb 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

const TEXT_PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 0000000..1111111 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

// The same shape PLUS the size-cap marker. The specific notice owns this one,
// so exactly one explanation must appear on the card.
const MARKED_OVERSIZED_STUB = [
  'diff --git a/assets/blob.pack b/assets/blob.pack',
  OVERSIZED_REVIEW_STUB_MARKER,
  'index 1111111111aa..2222222222bb 100644',
  'Binary files a/assets/blob.pack and b/assets/blob.pack differ',
  '',
].join('\n');

const NOTICE_SELECTOR = '[data-binary-file-notice]';
const OVERSIZED_NOTICE_SELECTOR = '[data-oversized-file-notice]';

function view(patch: string, filePath: string) {
  return (
    <DiffViewer
      patch={patch}
      filePath={filePath}
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
    />
  );
}

describe.if(hasDom)('contentless binary card presentation (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function render(patch: string, filePath: string) {
    // There is no expandable content for these shapes; keep the lookup inert.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(view(patch, filePath));
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

  test('a hunkless stub explains its empty body', async () => {
    const el = await render(STUB_PATCH, 'src/Panel.tsx');
    const notice = el.querySelector(NOTICE_SELECTOR);
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('content not shown');
  });

  test('a genuine binary file explains its empty body too', async () => {
    const el = await render(REAL_BINARY, 'assets/logo.png');
    expect(el.querySelector(NOTICE_SELECTOR)).not.toBeNull();
  });

  test('an ordinary text diff is left alone', async () => {
    const el = await render(TEXT_PATCH, 'calc.ts');
    expect(el.querySelector(NOTICE_SELECTOR)).toBeNull();
    expect(el.querySelector(OVERSIZED_NOTICE_SELECTOR)).toBeNull();
  });

  test('a marker-carrying stub is explained once, by the specific notice', async () => {
    // Specific beats general: the size-cap notice knows WHY the body is empty,
    // so the fallback must stand down rather than stack a second line on it.
    const el = await render(MARKED_OVERSIZED_STUB, 'assets/blob.pack');
    expect(el.querySelectorAll(OVERSIZED_NOTICE_SELECTOR).length).toBe(1);
    expect(el.querySelectorAll(NOTICE_SELECTOR).length).toBe(0);
    expect(el.textContent).not.toContain(OVERSIZED_REVIEW_STUB_MARKER);
  });
});
