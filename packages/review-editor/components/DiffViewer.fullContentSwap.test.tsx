/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileDiff as PierreFileDiff, getSingularPatch, processFile } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';

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

const filler = (n: number, name: string) =>
  Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n');
const HEAD = filler(60, 'head');
const TAIL = filler(50, 'tail');
const NEW_CONTENTS = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b;\n}\n${TAIL}\n`;
const OLD_CONTENTS = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b; // old\n}\n${TAIL}\n`;

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 0000000..1111111 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -59,7 +59,7 @@',
  ' const head58 = 58;',
  ' const head59 = 59;',
  ' export function add(a: number, b: number) {',
  '-  return a + b; // old',
  '+  return a + b;',
  ' }',
  ' const tail0 = 0;',
  ' const tail1 = 1;',
  '',
].join('\n');

function shadowHTML(host: HTMLElement): string {
  let out = host.innerHTML ?? '';
  const visit = (root: ParentNode) => {
    for (const el of root.querySelectorAll('*')) {
      const shadow = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        out += shadow.innerHTML ?? '';
        visit(shadow);
      }
    }
  };
  visit(host);
  return out;
}

function countExpandButtons(host: HTMLElement): number {
  return (shadowHTML(host).match(/data-expand-button/g) ?? []).length;
}

function renderedLines(host: HTMLElement): string {
  return [...host.querySelectorAll('diffs-container')].flatMap((element) =>
    [...(element.shadowRoot?.querySelectorAll('[data-line]') ?? [])].map((line) => line.textContent),
  ).join('\n');
}

function renderDiagnostics(host: HTMLElement | null, label: string): string {
  if (host == null) return `${label}: no host`;
  const html = shadowHTML(host);
  const count = (needle: string) => (html.match(new RegExp(needle, 'g')) ?? []).length;
  return [
    `${label}: shadowHTML ${html.length} chars`,
    `  diffs-container=${count('diffs-container')}`,
    `  data-separator=${count('data-separator')}`,
    `  data-expand-button=${count('data-expand-button')}`,
    `  data-line-number=${count('data-line-number')}`,
    `  head-fragment: ${html.slice(0, 600).replace(/\s+/g, ' ')}`,
  ].join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WAIT_TURNS = 400;

async function waitUntil(predicate: () => boolean, turns = WAIT_TURNS): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await act(async () => {
      await sleep(25);
    });
  }
  return predicate();
}

function view(overrides: Partial<React.ComponentProps<typeof DiffViewer>> = {}) {
  return (
    <DiffViewer
      patch={PATCH}
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
      {...overrides}
    />
  );
}

describe.if(hasDom)('DiffViewer full-content swap (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    mock.restore();
    globalThis.fetch = originalFetch;
  });

  test('full context waits for external contents without crashing the partial render', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
      await gate;
      return Response.json({ oldContent: OLD_CONTENTS, newContent: NEW_CONTENTS });
    }, { preconnect: originalFetch.preconnect }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    try {
      await act(async () => root!.render(view({ expandUnchanged: true })));
      expect(await waitUntil(() => renderedLines(host!).includes('return a + b;'))).toBe(true);
      expect(countExpandButtons(host!)).toBe(0);
      expect(renderedLines(host!)).not.toContain('const head0');

      await act(async () => {
        release();
      });
      expect(await waitUntil(() => renderedLines(host!).includes('const head0'))).toBe(true);
      expect(renderedLines(host!)).toContain('const tail49');
    } finally {
      release();
    }
  });

  test.each([
    { name: 'missing contents', status: 200, oldContent: null, newContent: null },
    { name: 'stale contents', status: 200, oldContent: OLD_CONTENTS, newContent: `${NEW_CONTENTS}extra line\n` },
    { name: 'rejected snapshot', status: 409, oldContent: null, newContent: null },
  ])('full context keeps a readable patch with $name', async ({ status, oldContent, newContent }) => {
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
      async () => Response.json({ oldContent, newContent }, { status }),
      { preconnect: originalFetch.preconnect },
    ));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(view({ expandUnchanged: true })));
    expect(await waitUntil(() => renderedLines(host!).includes('return a + b;'))).toBe(true);
    expect(renderedLines(host!)).not.toContain('const head0');
    expect(countExpandButtons(host!)).toBe(0);
  });

  test('All changes renders partial files with full context enabled', async () => {
    const fileDiff = getSingularPatch(PATCH);
    expect(fileDiff.isPartial).toBe(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <CodeView
          containerRef={(element) => {
            if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
          }}
          initialItems={[{ id: 'calc.ts', type: 'diff', fileDiff }]}
          options={{ expandUnchanged: true, diffStyle: 'unified', themeType: 'light' }}
        />,
      );
    });
    expect(await waitUntil(() => renderedLines(host!).includes('return a + b;'))).toBe(true);
    expect(countExpandButtons(host!)).toBe(0);
  });

  test('a configured loader still hydrates partial diffs', async () => {
    const loadDiffFiles = mock(async () => ({
      oldFile: { name: 'calc.ts', contents: OLD_CONTENTS },
      newFile: { name: 'calc.ts', contents: NEW_CONTENTS },
    }));
    const instance = new PierreFileDiff({ expandUnchanged: true, loadDiffFiles });
    host = document.createElement('div');
    document.body.appendChild(host);
    try {
      instance.render({ fileDiff: getSingularPatch(PATCH), fileContainer: host.appendChild(document.createElement('diffs-container')) });
      expect(await waitUntil(() => renderedLines(host!).includes('const head0'))).toBe(true);
      expect(loadDiffFiles).toHaveBeenCalledTimes(1);
      await expect(instance.prepareForEditing()).resolves.toBeUndefined();
    } finally {
      instance.cleanUp();
    }
  });

  test('partial diffs without a loader still cannot enter editing', async () => {
    const instance = new PierreFileDiff({ expandUnchanged: true });
    try {
      instance.render({ fileDiff: getSingularPatch(PATCH), fileContainer: document.createElement('diffs-container') });
      await expect(instance.prepareForEditing()).rejects.toThrow('a partial diff requires loadDiffFiles');
    } finally {
      instance.cleanUp();
    }
  });

  test(
    'expansion affordances appear once /api/file-content lands',
    async () => {
      let markRequested: (() => void) | null = null;
      const fileContentRequested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      let releaseFileContent: (() => void) | null = null;
      const fileContentGate = new Promise<void>((resolve) => {
        releaseFileContent = resolve;
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/file-content')) {
          markRequested?.();
          await fileContentGate;
          return new Response(
            JSON.stringify({ oldContent: OLD_CONTENTS, newContent: NEW_CONTENTS }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      expect(getSingularPatch(PATCH).isPartial).toBe(true);
      const expected = processFile(PATCH, {
        oldFile: { name: 'calc.ts', contents: OLD_CONTENTS },
        newFile: { name: 'calc.ts', contents: NEW_CONTENTS },
      });
      expect(expected?.isPartial).toBe(false);

      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(view());
      });

      await fileContentRequested;
      const painted = await waitUntil(() => shadowHTML(host!).includes('data-separator'));
      if (!painted) console.error(renderDiagnostics(host, 'partial diff never painted'));
      expect(countExpandButtons(host!)).toBe(0);

      await act(async () => {
        releaseFileContent!();
        await sleep(0);
      });

      const swapped = await waitUntil(() => countExpandButtons(host!) > 0);
      if (!swapped) console.error(renderDiagnostics(host, 'augmented diff never painted'));
      expect(swapped).toBe(true);

      expect(shadowHTML(host!)).toContain('data-expand-index');
    },
    180_000,
  );
});
