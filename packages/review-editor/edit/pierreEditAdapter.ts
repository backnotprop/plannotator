import type { CodeAnnotation } from '@plannotator/ui/types';

type EditModule = typeof import('@pierre/diffs/edit');

export type PierreEditorInstance = InstanceType<EditModule['Editor']>;
export type PierreEditorOptions = NonNullable<ConstructorParameters<EditModule['Editor']>[0]>;
export type PierreEditorMarker = Parameters<PierreEditorInstance['setMarkers']>[0][number];
export type PierreSelectionActionContext = Parameters<
  NonNullable<PierreEditorOptions['renderSelectionAction']>
>[0];

let modulePromise: Promise<EditModule> | null = null;
let loadedModule: EditModule | null = null;

export function isPierreEditLoaded(): boolean {
  return loadedModule != null;
}

export async function loadPierreEdit(): Promise<void> {
  if (!modulePromise) {
    modulePromise = import('@pierre/diffs/edit').then((mod) => {
      loadedModule = mod;
      return mod;
    });
  }
  await modulePromise;
}

export function createPierreEditor(options: PierreEditorOptions): PierreEditorInstance | undefined {
  if (!loadedModule) return undefined;
  return new loadedModule.Editor(options);
}

export function __resetPierreEditForTests(): void {
  modulePromise = null;
  loadedModule = null;
}

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
