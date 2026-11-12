import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import type { FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import { mergeExternalAnnotations } from './feedbackDocuments';

export interface DocumentDraftState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
}

export interface DocumentDraftWrite {
  path: string;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
}

const serialize = (state: DocumentDraftState): string =>
  JSON.stringify([state.annotations, state.globalAttachments]);

const EMPTY = serialize({ annotations: [], globalAttachments: [] });

export function planDocumentDraftWrites(input: {
  documents: ReadonlyMap<string, DocumentDraftState>;
  lastSent: ReadonlyMap<string, string>;
  loaded: ReadonlySet<string>;
  rootPath?: string | null;
}): { writes: DocumentDraftWrite[]; sent: Map<string, string> } {
  const writes: DocumentDraftWrite[] = [];
  const sent = new Map(input.lastSent);
  const seen = new Set<string>();
  for (const [path, state] of input.documents) {
    if (input.rootPath && path === input.rootPath) continue;
    if (!input.loaded.has(path)) continue;
    seen.add(path);
    const next = serialize(state);
    const previous = input.lastSent.get(path);
    if (previous === next) continue;
    if (previous === undefined && next === EMPTY) continue;
    writes.push({ path, annotations: state.annotations, globalAttachments: state.globalAttachments });
    sent.set(path, next);
  }
  for (const [path, previous] of input.lastSent) {
    if (seen.has(path) || previous === EMPTY) continue;
    writes.push({ path, annotations: [], globalAttachments: [] });
    sent.set(path, EMPTY);
  }
  return { writes, sent };
}

export function documentDraftAdditions(
  held: DocumentDraftState,
  saved: { annotations: unknown; globalAttachments: unknown },
): DocumentDraftState {
  const heldIds = new Set(held.annotations.map((a) => a.id));
  const heldPaths = new Set(held.globalAttachments.map((g) => g.path));
  const annotations = (Array.isArray(saved.annotations) ? saved.annotations : []).filter(
    (a): a is Annotation =>
      !!a && typeof a === 'object' && typeof (a as Annotation).id === 'string' && !heldIds.has((a as Annotation).id),
  );
  const globalAttachments = (Array.isArray(saved.globalAttachments) ? saved.globalAttachments : []).filter(
    (g): g is ImageAttachment =>
      !!g && typeof g === 'object' && typeof (g as ImageAttachment).path === 'string' && !heldPaths.has((g as ImageAttachment).path),
  );
  return { annotations, globalAttachments };
}

export function composeSessionDraft(input: {
  enabled: boolean;
  live: DocumentDraftState;
  feedbackDocuments: FeedbackDocuments;
  externalAnnotations: Annotation[];
  rootPath: string | null;
  unbackedPaths: ReadonlySet<string>;
}): DocumentDraftState {
  if (!input.enabled) return input.live;
  const { root, documents } = input.feedbackDocuments;
  const base: DocumentDraftState = root
    ? { annotations: mergeExternalAnnotations(root.annotations, input.externalAnnotations), globalAttachments: root.globalAttachments }
    : input.live;
  const extraAnnotations: Annotation[] = [];
  const extraAttachments: ImageAttachment[] = [];
  for (const [path, state] of documents) {
    if (path !== input.rootPath && !input.unbackedPaths.has(path)) continue;
    extraAnnotations.push(...state.annotations);
    extraAttachments.push(...state.globalAttachments);
  }
  if (extraAnnotations.length === 0 && extraAttachments.length === 0) return base;
  return {
    annotations: [...base.annotations, ...extraAnnotations],
    globalAttachments: [...base.globalAttachments, ...extraAttachments],
  };
}
