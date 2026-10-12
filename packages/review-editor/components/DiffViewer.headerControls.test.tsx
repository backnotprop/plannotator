/**
 * The control-visibility preferences (#1277) must gate the per-file diff
 * header too: a reviewer who turned the Viewed / Git Add controls off in the
 * Tree controls popover should not see them anywhere. Guards the flag
 * threading DiffViewer -> FileHeader (each flag hides only its own button,
 * and a visible button still fires its handler). The V / A shortcuts bypass
 * these buttons by design and are not exercised here.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run diff-renderer DOM tests" step.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

const MARKDOWN_PATCH = [
  'diff --git a/README.md b/README.md',
  'index 0000000..1111111 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,3 +1,5 @@',
  '-# Old',
  '+# New',
  ' ',
  '-old text',
  '+| Feature | Status |',
  '+| --- | --- |',
  '+| Preview | **Ready** |',
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

const VIEWED_BUTTON = 'button[title*="viewed (V)"]';
const STAGE_BUTTON = 'button[title*="this file (A)"]';

describe.if(hasDom)('header control visibility (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  async function render(
    node: React.ReactElement,
    contents: { oldContent: string | null; newContent: string | null } = { oldContent: null, newContent: null },
  ) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(contents), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(node);
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

  function view(
    props: Partial<React.ComponentProps<typeof DiffViewer>>,
    onToggleViewed: () => void,
  ) {
    return (
      <DiffViewer
        patch={TEXT_PATCH}
        filePath="calc.ts"
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
        onToggleViewed={onToggleViewed}
        onStage={() => {}}
        canStage
        {...props}
      />
    );
  }

  test('both header buttons render by default and Viewed fires its handler', async () => {
    let toggled = 0;
    const el = await render(view({}, () => toggled++));
    const viewedBtn = el.querySelector<HTMLButtonElement>(VIEWED_BUTTON);
    expect(viewedBtn).not.toBeNull();
    expect(el.querySelector(STAGE_BUTTON)).not.toBeNull();
    await act(async () => viewedBtn!.click());
    expect(toggled).toBe(1);
  });

  test('showViewedControls={false} hides only the Viewed button', async () => {
    const el = await render(view({ showViewedControls: false }, () => {}));
    expect(el.querySelector(VIEWED_BUTTON)).toBeNull();
    expect(el.querySelector(STAGE_BUTTON)).not.toBeNull();
  });

  test('showStageControls={false} hides only the Git Add button', async () => {
    const el = await render(view({ showStageControls: false }, () => {}));
    expect(el.querySelector(STAGE_BUTTON)).toBeNull();
    expect(el.querySelector(VIEWED_BUTTON)).not.toBeNull();
  });

  test('Markdown preview renders the complete updated document and returns to the diff', async () => {
    const oldContent = '# Old\n\nold text\n';
    const newContent = '# New\n\n| Feature | Status |\n| --- | --- |\n| Preview | **Ready** |\n';
    const el = await render(
      view({ patch: MARKDOWN_PATCH, filePath: 'README.md' }, () => {}),
      { oldContent, newContent },
    );

    const toggle = el.querySelector<HTMLButtonElement>('[data-markdown-preview-toggle]');
    // Deliberate: one accessible name in both states (aria-pressed carries it).
    expect(toggle?.getAttribute('aria-label')).toBe('Markdown preview');
    await act(async () => toggle!.click());

    expect(el.querySelector('h1')?.textContent).toBe('New');
    expect(el.querySelector('table')).not.toBeNull();
    expect(el.textContent).toContain('Ready');
    expect(el.querySelector('[data-markdown-preview-toggle]')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => el.querySelector<HTMLButtonElement>('[data-markdown-preview-toggle]')!.click());
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelector('[data-markdown-preview-toggle]')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('non-Markdown files do not show the preview toggle', async () => {
    const el = await render(view({}, () => {}));
    expect(el.querySelector('[data-markdown-preview-toggle]')).toBeNull();
  });

});
