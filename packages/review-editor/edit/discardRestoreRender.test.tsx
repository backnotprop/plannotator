/**
 * Discard must repaint the pristine diff PROMPTLY.
 *
 * Empirical repro of the QA-confirmed defect: after an edit session ends via
 * Discard, `writeRestore` correctly writes the pristine fileDiff (fresh
 * cacheKey, edit off, version bump, updateItem) — app/item state ends fully
 * pristine — but @pierre/diffs 1.3.2's DiffHunksRenderer.renderDiff only
 * swaps its render cache for new content while the cache is UNhighlighted.
 * The ended session leaves `renderCache.highlighted === true`, so the
 * teardown repaint keeps painting the stale EDITED content and merely queues
 * an async worker highlight of the pristine diff (30ms-seconds away, or
 * never if that task is invalidated). The fix clears the live instance's
 * render cache after the restore write so the very next paint takes the
 * cold-render path and shows pristine immediately.
 *
 * This is a full integration test: the REAL @pierre/diffs React CodeView +
 * EditProvider + worker pool (real Bun workers under happy-dom), the real
 * lazy editor chunk, real `Editor.applyEdits`, and the real useEditSession
 * controller. The assertion is deliberately bounded to a short settle after
 * `cancelEdit` — the pristine pixels must be there promptly, not after an
 * unbounded async heal.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import {
  CodeView,
  EditProvider,
  WorkerPoolContextProvider,
  type CodeViewHandle,
} from '@pierre/diffs/react';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { useEditSession, type EditSessionApi } from './useEditSession';

const hasDom = typeof document !== 'undefined';

// The repo's happy-dom preload (packages/ui/test-setup/happy-dom.ts) keeps
// Bun's native Worker global, so the pool below spawns REAL workers running
// Pierre's actual worker script — the bug only exists on the worker-pool
// rendering path.
const workerScriptPath = fileURLToPath(import.meta.resolve('@pierre/diffs/worker/worker.js'));
const spawnedWorkers: Worker[] = [];

// happy-dom has no canvas 2d context; the editor's TextMeasure needs one.
const CanvasProto = hasDom
  ? (globalThis as unknown as { HTMLCanvasElement?: { prototype: HTMLCanvasElement } })
      .HTMLCanvasElement?.prototype
  : undefined;
const originalGetContext = CanvasProto?.getContext;
if (CanvasProto) {
  (CanvasProto as unknown as { getContext: unknown }).getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === '2d') {
      return {
        font: '',
        measureText: (text: string) => ({ width: (text?.length ?? 0) * 8 }),
      };
    }
    return (originalGetContext as ((...args: unknown[]) => unknown) | undefined)?.call(
      this,
      type,
      ...rest,
    ) ?? null;
  };
}

afterAll(() => {
  if (CanvasProto && originalGetContext) {
    (CanvasProto as unknown as { getContext: unknown }).getContext = originalGetContext;
  }
  for (const worker of spawnedWorkers) {
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
  }
});

// A realistically sized file (not a 3-liner) so the unfixed async heal has a
// real window — matching how the defect presents on actual review diffs.
const filler = (n: number, name: string) =>
  Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n');
const HEAD = filler(60, 'filler');
const TAIL = filler(50, 'tail');
const PRISTINE_NEW = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b;\n}\n${TAIL}\n`;
const OLD = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b; // old\n}\n${TAIL}\n`;

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 0000000..1111111 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -58,7 +58,7 @@',
  ' const filler57 = 57;',
  ' const filler58 = 58;',
  ' const filler59 = 59;',
  ' export function add(a: number, b: number) {',
  '-  return a + b; // old',
  '+  return a + b;',
  ' }',
  ' const tail0 = 0;',
  '',
].join('\n');

const PRISTINE_MARKER = 'return a + b;';
const EDITED_MARKER = 'edited-marker';

/** All text content including shadow roots (Pierre renders into shadow DOM). */
function shadowText(host: HTMLElement): string {
  let out = host.textContent ?? '';
  const visit = (root: ParentNode) => {
    for (const el of root.querySelectorAll('*')) {
      const shadow = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        out += shadow.textContent ?? '';
        visit(shadow);
      }
    }
  };
  visit(host);
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await act(async () => {
      await sleep(stepMs);
    });
  }
  return predicate();
}

describe.if(hasDom)('edit-mode Discard repaints the pristine diff (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterAll(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  test(
    'pristine content is visible (and edited content gone) promptly after cancelEdit',
    async () => {
      const fileDiff = processFile(PATCH, {
        oldFile: { name: 'calc.ts', contents: OLD },
        newFile: { name: 'calc.ts', contents: PRISTINE_NEW },
      }) as FileDiffMetadata;
      expect(fileDiff).toBeTruthy();
      fileDiff.cacheKey = 'gen-1::item-1';

      const item = {
        id: 'item-1',
        type: 'diff',
        fileDiff,
        version: 0,
      } as CodeViewItem<DiffAnnotationMetadata>;
      const file: DiffFile = {
        path: 'calc.ts',
        patch: PATCH,
        additions: 1,
        deletions: 1,
        status: 'modified',
      };

      let api: EditSessionApi | null = null;
      let handle: CodeViewHandle<DiffAnnotationMetadata> | null = null;
      const fileSetKeyRef = { current: 'gen-1' };

      function Harness() {
        const viewerRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(null);
        const itemIdToFileRef = useRef(new Map([[item.id, file]]));
        const reviewBaseRef = useRef<string | undefined>(undefined);
        const reviewSnapshotIdRef = useRef<string | undefined>(undefined);
        const annotationsRef = useRef([]);
        api = useEditSession({
          enabled: true,
          viewerRef,
          itemIdToFileRef,
          fileSetKeyRef,
          reviewBaseRef,
          reviewSnapshotIdRef,
          annotationsRef,
          onAddSuggestions: () => {},
          refreshItem: () => {},
        });
        return (
          <EditProvider createEditor={api.createEditor}>
            <CodeView<DiffAnnotationMetadata>
              ref={(h) => {
                viewerRef.current = h;
                handle = h;
              }}
              // happy-dom reports zero-size rects; give the virtualizer a
              // viewport so the item actually renders.
              containerRef={(el) => {
                if (el) {
                  (el as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
                    ({
                      x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800,
                      width: 1000, height: 800,
                      toJSON() { return {}; },
                    }) as DOMRect;
                }
              }}
              initialItems={[item]}
              editorOptions={api.editorOptions}
              onItemEditChange={api.onItemEditChange}
              onItemEditComplete={api.onItemEditComplete}
            />
          </EditProvider>
        );
      }

      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <WorkerPoolContextProvider
            poolOptions={{
              poolSize: 1,
              totalASTLRUCacheSize: 100,
              workerFactory: () => {
                const worker = new Worker(workerScriptPath);
                spawnedWorkers.push(worker);
                return worker;
              },
            }}
            highlighterOptions={{
              preferredHighlighter: 'shiki-js',
              useTokenTransformer: true,
              langs: ['typescript'],
            }}
          >
            <Harness />
          </WorkerPoolContextProvider>,
        );
      });

      // Reach the live FileDiff instance the same way the fix does.
      const getInstance = () =>
        handle
          ?.getInstance()
          ?.getRenderedItems()
          .find((r) => r.id === item.id)?.instance as
          | {
              hunksRenderer?: { renderCache?: { highlighted?: boolean } };
            }
          | undefined;

      // Wait for the initial render to reach a HIGHLIGHTED cache — the exact
      // precondition under which upstream's renderDiff refuses to swap
      // content on the restore repaint.
      expect(
        await waitFor(() => getInstance()?.hunksRenderer?.renderCache?.highlighted === true, 15_000),
      ).toBe(true);
      expect(shadowText(host)).toContain(PRISTINE_MARKER);

      // Enter edit mode through the real controller (awaits the real lazy
      // editor chunk, then flips item.edit on).
      await act(async () => {
        api!.startEdit(item.id);
      });
      expect(await waitFor(() => api!.editingItemIdRef.current === item.id, 10_000)).toBe(true);
      expect(await waitFor(() => handle?.getEditor(item.id) != null, 10_000)).toBe(true);

      // A real keystroke through the real Editor: insert a uniquely
      // greppable line into the function body.
      const editor = handle!.getEditor(item.id) as unknown as {
        applyEdits: (edits: unknown[]) => void;
      };
      await act(async () => {
        editor.applyEdits([
          {
            range: { start: { line: 61, character: 0 }, end: { line: 61, character: 0 } },
            newText: `  // ${EDITED_MARKER}\n`,
          },
        ]);
      });
      expect(await waitFor(() => shadowText(host!).includes(EDITED_MARKER), 10_000)).toBe(true);

      // DISCARD, then assert within one short bounded settle (a frame's
      // worth) — NOT after the unbounded async worker heal the unfixed code
      // depends on.
      await act(async () => {
        api!.cancelEdit();
      });
      await act(async () => {
        await sleep(16);
      });

      const text = shadowText(host!);
      expect(text).toContain(PRISTINE_MARKER);
      expect(text).not.toContain(EDITED_MARKER);
      // And no annotation was created: Discard leaves state fully pristine.
      expect(api!.editingItemIdRef.current).toBeNull();
    },
    60_000,
  );
});
