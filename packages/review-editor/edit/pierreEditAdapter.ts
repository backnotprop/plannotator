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
/** Pierre's `SelectionActionContext`, re-derived structurally from the
 * `renderSelectionAction` editor option (it has no public export path). */
export type PierreSelectionActionContext = Parameters<
  NonNullable<PierreEditorOptions['renderSelectionAction']>
>[0];

let modulePromise: Promise<EditModule> | null = null;
let loadedModule: EditModule | null = null;

/** Whether the editor module has finished loading (factory calls before this resolves decline the attach). */
export function isPierreEditLoaded(): boolean {
  return loadedModule != null;
}

/**
 * Load the editor chunk. Idempotent; the session controller awaits this
 * BEFORE flipping any item into edit mode, so the factory below never runs
 * unloaded in practice. That ordering matters: the core CodeView treats a
 * null factory return as "decline the attach", but the React wrapper's shim
 * THROWS on an undefined return ("EditProvider.createEditor must return an
 * editor instance"), so an unloaded factory is not a graceful retry path.
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
 * until `loadPierreEdit()` has resolved. This is a defensive guard, not a
 * documented retry contract: the React CodeView wrapper throws on an
 * undefined return, which would fail that attach. The session controller
 * awaits `loadPierreEdit()` before any item enters edit mode, so the guard
 * is unreachable in the wired flow.
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
 *
 * The range must have real width: upstream's overlay renderer skips
 * zero-width blocks (`#renderSelectionBlock` returns on width 0), so a
 * collapsed `start === end` range never paints. Ending at character 0 of the
 * line AFTER the last annotated line covers every annotated line in full
 * (the exclusive-end LSP convention); the editor's TextDocument clamps an
 * end past the last line back to end-of-document.
 */
export function buildEditorMarkers(annotations: CodeAnnotation[], filePath: string): PierreEditorMarker[] {
  const markers: PierreEditorMarker[] = [];
  for (const ann of annotations) {
    if (ann.filePath !== filePath || (ann.scope ?? 'line') !== 'line' || ann.side !== 'new') continue;
    const message = ann.text || (ann.suggestedCode ? 'Suggested change' : 'Comment');
    const startLine = Math.max(0, ann.lineStart - 1);
    markers.push({
      start: { line: startLine, character: 0 },
      end: { line: Math.max(ann.lineEnd, startLine + 1), character: 0 },
      severity: ann.severity === 'important' || ann.type === 'concern' ? 'warning' : 'info',
      message,
      source: ann.source || ann.author || 'plannotator',
    });
  }
  return markers;
}
