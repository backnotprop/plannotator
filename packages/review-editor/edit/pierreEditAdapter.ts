/**
 * Adapter wall for Pierre's EXPERIMENTAL edit mode.
 *
 * Every reference to `@pierre/diffs/edit` in this repo lives in THIS module —
 * runtime imports are dynamic (the editor code never loads until a user
 * actually enters edit mode) and type references are `import type` only, so
 * an upstream rename/reshape of the edit entry is a one-file fix here.
 *
 * App code must import editor types and functions from this module, never
 * from `@pierre/diffs/edit` directly. (`packages/review-editor/edit/
 * adapterWall.test.ts` enforces this.)
 *
 * Notes pinned to @pierre/diffs 1.3.1:
 * - The edit entry exports only `Editor` and `TextDocument`; sessions are
 *   driven by CodeView via `item.edit = true` + an `EditProvider` factory.
 * - `persistState` is deliberately NOT used (upstream bug, open PR #1048;
 *   it is also file-item-only — diff items never persist state anyway).
 * - `Marker` / `SelectionActionContext` have no public export path, so they
 *   are re-derived structurally from the `Editor` class type.
 */
import type { CodeAnnotation } from '@plannotator/ui/types';

type EditModule = typeof import('@pierre/diffs/edit');

/** The concrete editor class instance (structural — never import the class type directly elsewhere). */
export type PierreEditorInstance = InstanceType<EditModule['Editor']>;
/** Constructor options for the editor (Pierre's `EditorOptions`). */
export type PierreEditorOptions = NonNullable<ConstructorParameters<EditModule['Editor']>[0]>;
/** Pierre's `Marker` type, re-derived structurally (it has no export path). */
export type PierreEditorMarker = Parameters<PierreEditorInstance['setMarkers']>[0][number];

let modulePromise: Promise<EditModule> | null = null;
let loadedModule: EditModule | null = null;

/** Whether the editor module has finished loading (factory calls before this resolves decline the attach). */
export function isPierreEditLoaded(): boolean {
  return loadedModule != null;
}

/**
 * Load the editor chunk. Idempotent; called when the user first enters edit
 * mode. CodeView's `createEditor` factory contract allows returning undefined
 * to decline an attach (it retries on later render passes), so a factory
 * backed by this loader is safe to install before the module has loaded.
 */
export async function loadPierreEdit(): Promise<void> {
  if (!modulePromise) {
    modulePromise = import('@pierre/diffs/edit').then((mod) => {
      loadedModule = mod;
      return mod;
    });
  }
  await modulePromise;
}

/**
 * Synchronous editor factory for Pierre's `EditProvider`. Returns undefined
 * until `loadPierreEdit()` has resolved — CodeView treats that as "decline
 * and retry", which is exactly the lazy-load behavior we want.
 */
export function createPierreEditor(options: PierreEditorOptions): PierreEditorInstance | undefined {
  if (!loadedModule) return undefined;
  return new loadedModule.Editor(options);
}

/** Test-only: reset module state so load-order tests are deterministic. */
export function __resetPierreEditForTests(): void {
  modulePromise = null;
  loadedModule = null;
}

/**
 * Project a file's existing line annotations (agent findings, review
 * comments) into editor severity markers so they stay visible during an edit
 * session. Marker ranges are zero-based LSP-shaped positions; annotations are
 * 1-based file line numbers. Only new-side line annotations map (the editor
 * document IS the new side).
 */
export function buildEditorMarkers(annotations: CodeAnnotation[], filePath: string): PierreEditorMarker[] {
  const markers: PierreEditorMarker[] = [];
  for (const ann of annotations) {
    if (ann.filePath !== filePath || (ann.scope ?? 'line') !== 'line' || ann.side !== 'new') continue;
    const message = ann.text || (ann.suggestedCode ? 'Suggested change' : 'Comment');
    markers.push({
      start: { line: Math.max(0, ann.lineStart - 1), character: 0 },
      end: { line: Math.max(0, ann.lineEnd - 1), character: 0 },
      severity: ann.severity === 'important' || ann.type === 'concern' ? 'warning' : 'info',
      message,
      source: ann.source || ann.author || 'plannotator',
    });
  }
  return markers;
}
