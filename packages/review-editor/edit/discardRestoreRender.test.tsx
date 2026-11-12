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

const workerScriptPath = fileURLToPath(import.meta.resolve('@pierre/diffs/worker/worker.js'));
const spawnedWorkers: Worker[] = [];

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
    }
  }
});

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

      const getInstance = () =>
        handle
          ?.getInstance()
          ?.getRenderedItems()
          .find((r) => r.id === item.id)?.instance as
          | {
              hunksRenderer?: { renderCache?: { highlighted?: boolean } };
            }
          | undefined;

      expect(
        await waitFor(() => getInstance()?.hunksRenderer?.renderCache?.highlighted === true, 15_000),
      ).toBe(true);
      expect(shadowText(host)).toContain(PRISTINE_MARKER);

      await act(async () => {
        api!.startEdit(item.id);
      });
      expect(await waitFor(() => api!.editingItemIdRef.current === item.id, 10_000)).toBe(true);
      expect(await waitFor(() => handle?.getEditor(item.id) != null, 10_000)).toBe(true);

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

      await act(async () => {
        api!.cancelEdit();
      });
      await act(async () => {
        await sleep(16);
      });

      const text = shadowText(host!);
      expect(text).toContain(PRISTINE_MARKER);
      expect(text).not.toContain(EDITED_MARKER);
      expect(api!.editingItemIdRef.current).toBeNull();
    },
    60_000,
  );
});
