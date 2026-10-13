import { describe, expect, test } from 'bun:test';
import type { Annotation } from '@plannotator/ui/types';
import { composeSessionDraft, documentDraftAdditions, planDocumentDraftWrites, type DocumentDraftState } from './documentDrafts';

const ann = (id: string) => ({ id, text: id }) as unknown as Annotation;
const state = (...ids: string[]): DocumentDraftState => ({ annotations: ids.map(ann), globalAttachments: [] });

describe('planDocumentDraftWrites', () => {
  test('never writes a document whose saved copy has not been read yet', () => {
    // Writing it would replace an earlier session's comments with this subset.
    const { writes } = planDocumentDraftWrites({
      documents: new Map([['/d/a.md', state('mine')]]),
      lastSent: new Map(),
      loaded: new Set(),
    });
    expect(writes).toEqual([]);
  });

  test('writes changed documents once, and skips the session root', () => {
    const documents = new Map([['/d/a.md', state('c1')], ['/d/root.md', state('r')]]);
    const first = planDocumentDraftWrites({
      documents,
      lastSent: new Map(),
      loaded: new Set(['/d/a.md', '/d/root.md']),
      rootPath: '/d/root.md',
    });
    expect(first.writes.map((w) => w.path)).toEqual(['/d/a.md']);
    const again = planDocumentDraftWrites({ documents, lastSent: first.sent, loaded: new Set(['/d/a.md']), rootPath: '/d/root.md' });
    expect(again.writes).toEqual([]);
  });

  test('clears a document whose comments were all deleted, but never sends an untouched one empty', () => {
    const loaded = new Set(['/d/a.md', '/d/b.md']);
    const sent = planDocumentDraftWrites({ documents: new Map([['/d/a.md', state('c1')]]), lastSent: new Map(), loaded }).sent;
    const { writes } = planDocumentDraftWrites({
      documents: new Map([['/d/a.md', state()], ['/d/b.md', state()]]),
      lastSent: sent,
      loaded,
    });
    expect(writes).toEqual([{ path: '/d/a.md', annotations: [], globalAttachments: [] }]);
  });
});

describe('documentDraftAdditions', () => {
  test('adds only the saved comments the session does not already hold', () => {
    const additions = documentDraftAdditions(state('kept'), {
      annotations: [ann('kept'), ann('new'), { notAnAnnotation: true }],
      globalAttachments: [],
    });
    expect(additions.annotations.map((a) => a.id)).toEqual(['new']);
  });
});

describe('composeSessionDraft', () => {
  const live = state('open-doc');
  const rootState = { ...state('root-comment'), markdown: '', renderAs: 'markdown' as const };

  test('without per-document copies the session draft is the open document, as before', () => {
    const draft = composeSessionDraft({
      enabled: false,
      live,
      feedbackDocuments: { root: rootState, documents: new Map([['/d/a.md', live]]) },
      externalAnnotations: [],
      rootPath: null,
      unbackedPaths: new Set(),
    });
    expect(draft.annotations.map((a) => a.id)).toEqual(['open-doc']);
  });

  test('with them it is the root while a backed document is open', () => {
    const draft = composeSessionDraft({
      enabled: true,
      live,
      feedbackDocuments: { root: rootState, documents: new Map([['/d/a.md', live]]) },
      externalAnnotations: [],
      rootPath: '/d/root.md',
      unbackedPaths: new Set(),
    });
    expect(draft.annotations.map((a) => a.id)).toEqual(['root-comment']);
  });

  test('documents with no path copy (a vault document, a self-link copy of the root) ride the session draft', () => {
    const draft = composeSessionDraft({
      enabled: true,
      live,
      feedbackDocuments: {
        root: rootState,
        documents: new Map([
          ['/vault/note.md', state('vault-comment')],
          ['/d/root.md', state('self-copy-comment')],
          ['/d/backed.md', state('backed-comment')],
        ]),
      },
      externalAnnotations: [],
      rootPath: '/d/root.md',
      unbackedPaths: new Set(['/vault/note.md']),
    });
    expect(draft.annotations.map((a) => a.id)).toEqual(['root-comment', 'vault-comment', 'self-copy-comment']);
  });
});
