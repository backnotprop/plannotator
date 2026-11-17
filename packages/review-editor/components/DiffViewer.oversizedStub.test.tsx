/**
 * A file over the review size cap must SAY why its card is empty.
 *
 * The review core replaces such files with a contents-free stub patch
 * (`buildOversizedTrackedStub`), which @pierre/diffs renders as a body with no
 * lines. Before this, the card was a bare header with no counts and no reason,
 * and users read it as a broken diff. The stub carries an explicit marker line
 * (`OVERSIZED_REVIEW_STUB_MARKER`) so the UI can tell it apart from a genuine
 * binary file, which must keep rendering exactly as it always did.
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run diff-renderer DOM tests (isolated, real @pierre/diffs)" step — its own
 * process, because a file in the shared DOM step mocks '@pierre/diffs'
 * process-wide and this renders against the real renderer.
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

const OVERSIZED_STUB = [
  'diff --git a/assets/blob.pack b/assets/blob.pack',
  OVERSIZED_REVIEW_STUB_MARKER,
  'index 1111111111aa..2222222222bb 100644',
  'Binary files a/assets/blob.pack and b/assets/blob.pack differ',
  '',
].join('\n');

// A genuine binary file: same shape MINUS the marker. It must not pick up the
// size-cap explanation, which would be a lie about why it has no diff.
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

const NOTICE_SELECTOR = '[data-oversized-file-notice]';
const NOTICE_COPY = 'review limit';

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

describe.if(hasDom)('oversized-file stub presentation (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function render(patch: string, filePath: string) {
    // No expandable content for a stub; keep the lookup inert either way.
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

  test('an oversized stub explains itself', async () => {
    const el = await render(OVERSIZED_STUB, 'assets/blob.pack');
    const notice = el.querySelector(NOTICE_SELECTOR);
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(NOTICE_COPY);
    // The raw marker is plumbing, never user-facing copy.
    expect(el.textContent).not.toContain(OVERSIZED_REVIEW_STUB_MARKER);
  });

  test('a genuine binary file is left alone', async () => {
    const el = await render(REAL_BINARY, 'assets/logo.png');
    expect(el.querySelector(NOTICE_SELECTOR)).toBeNull();
  });

  test('an ordinary text diff is left alone', async () => {
    const el = await render(TEXT_PATCH, 'calc.ts');
    expect(el.querySelector(NOTICE_SELECTOR)).toBeNull();
  });
});
