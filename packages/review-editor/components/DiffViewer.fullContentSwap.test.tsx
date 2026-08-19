/**
 * The single-file diff tab must actually REPAINT when the full-content diff
 * arrives.
 *
 * DiffViewer renders twice for every file it shows: first the PARTIAL diff
 * parsed from the raw patch (`getSingularPatch`), then, once
 * `/api/file-content` resolves, an AUGMENTED full-content diff
 * (`processFile`) swapped onto the SAME surviving FileDiff instance
 * (`key={filePath}`). Only the augmented diff can be expanded, so the
 * gutter's expansion chevrons appear only after the swap lands.
 *
 * @pierre/diffs 1.3.2 defaults `fileDiff.cacheKey` to the file NAME when the
 * caller leaves it unset, and `areDiffTargetsEqual` compares nothing but that
 * key. Two diffs of the same file therefore look identical to the render
 * cache, so the augmented diff is served the stale partial render forever:
 * gap bars with no chevrons, dead clicks, at every file size. The fix mints
 * content-derived cache keys for BOTH diffs.
 *
 * Real @pierre/diffs (no diff mocks) — the defect lives entirely inside its
 * DiffHunksRenderer cache, so a mocked renderer would prove nothing. Only
 * DiffViewer's Vite-only worker-pool module and the theme/toolbar chrome are
 * stubbed.
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run diff-renderer DOM tests (isolated, real @pierre/diffs)" step. Its own
 * process on purpose: a file in the shared DOM step mocks '@pierre/diffs'
 * process-wide, and this test is only meaningful against the real renderer.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getSingularPatch, processFile } from '@pierre/diffs';

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

// A realistically sized file so there is genuine collapsed context above and
// below the hunk — the gaps whose chevrons are the user-visible symptom.
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
  // `const head58 = 58;` really is line 59 of both contents, so the header,
  // the context lines and the files agree. Pierre realigns a misaligned header
  // rather than rejecting it, which makes a wrong one a silent trap.
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

/** All markup including shadow roots (Pierre renders into shadow DOM). */
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

/**
 * What Pierre actually painted, for when a wait gives up.
 *
 * A bare "expected true, received false" from a render wait says nothing about
 * WHICH of the several things upstream of the pixels went wrong, and this test
 * has already cost one CI round trip to a mystery. Printed only on failure.
 */
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

/**
 * Wait for a rendered state, budgeted in SCHEDULER TURNS rather than
 * milliseconds.
 *
 * A wall-clock budget makes the test a stopwatch race against the runner: a
 * cold, contended CI box blows a deadline that a warm laptop clears, which is
 * exactly how the first version of this test flaked. Turns are machine
 * independent — a slower box simply spends longer inside each turn — so this
 * budget never has to be retuned for CI hardware. Every turn is an `act`
 * flushed macrotask boundary, so it also drains microtasks; the states waited
 * on here are at most a two step async chain past a synchronous render, which
 * makes 400 turns a ~100x margin rather than a guess.
 *
 * What is waited on is the completion signal itself, not a proxy for one:
 * Pierre renders expansion chevrons only from a NON-PARTIAL diff, so their
 * presence IS the augmented diff having reached paint.
 */
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
    globalThis.fetch = originalFetch;
  });

  test(
    'expansion affordances appear once /api/file-content lands',
    async () => {
      // The full-content response is held until the partial baseline has been
      // asserted — with the fix the swap lands within a frame, so an
      // unthrottled response would race the baseline check.
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

      // Precondition, asserted rather than assumed: the REAL parser and the
      // REAL augmenter, on these exact fixtures, must produce a non-partial
      // diff. Bun's `mock.module` is process global and earlier files in the
      // DOM suite mock this very specifier, so this also fails loudly (and in
      // milliseconds) if a stale module mock ever reaches this file, instead of
      // presenting as an inexplicable render that never arrives.
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

      // The gate is still closed here, so the augmented diff cannot exist yet
      // no matter how slow the box is.
      await fileContentRequested;
      // Reported, deliberately NOT asserted. The verdict belongs to the swap
      // below: whether the partial diff had painted first only affects how
      // strong the "no chevrons yet" observation is, and making it a hard gate
      // would let a slow or absent FIRST paint mask the result we actually
      // came for. A tree without the fix still fails, because it never paints
      // chevrons at any point.
      const painted = await waitUntil(() => shadowHTML(host!).includes('data-separator'));
      if (!painted) console.error(renderDiagnostics(host, 'partial diff never painted'));
      // A partial diff is not expandable, so Pierre draws its gap bars without
      // chevrons. This is the state the stale render cache freezes forever.
      expect(countExpandButtons(host!)).toBe(0);

      await act(async () => {
        releaseFileContent!();
        await sleep(0);
      });

      // The augmented full-content diff must reach the PIXELS, not just the
      // React tree: expansion chevrons in the gap bars. With the fix these
      // arrive in the first turn or two; without it they never arrive at all.
      const swapped = await waitUntil(() => countExpandButtons(host!) > 0);
      if (!swapped) console.error(renderDiagnostics(host, 'augmented diff never painted'));
      expect(swapped).toBe(true);

      // And the separator now advertises a real expand target, which is what
      // makes the click live rather than dead.
      expect(shadowHTML(host!)).toContain('data-expand-index');
    },
    // The only wall-clock bound in this test, and only a backstop: the
    // assertions themselves are budgeted in scheduler turns.
    180_000,
  );
});
