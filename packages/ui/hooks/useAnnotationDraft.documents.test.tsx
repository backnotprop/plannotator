/**
 * A recovered draft that carries other documents' comments (#1545).
 *
 * In plan review, and in annotate sessions on a URL or the last message, the
 * server offers each linked document's saved comments with the session draft
 * (`documents` on GET /api/draft, packages/shared/annotate-draft.ts). What
 * regresses if this fails:
 *  - Draft Recovered counts only the root's comments, or offers nothing when
 *    only a linked document has comments (the reviewer cannot get them back);
 *  - restoring puts a linked document's comments on the root, or drops them;
 *  - dismissing leaves the host no way to discard those documents' copies,
 *    so dismissed comments come back when a document is opened.
 *
 * Requires DOM (happy-dom preload).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as useAnnotationDraftModule from './useAnnotationDraft';
import { AnnotationType, type Annotation } from '../types';
import type { DraftTransport } from './useAnnotationDraft';

const setDraftTransport = useAnnotationDraftModule.setDraftTransport;
const resetDraftTransport = useAnnotationDraftModule.resetDraftTransport;
const useAnnotationDraft = useAnnotationDraftModule.useAnnotationDraft;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetDraftTransport();
  if (hasDom) document.body.innerHTML = '';
});

const note = (id: string): Annotation => ({
  id,
  blockId: '',
  startOffset: 0,
  endOffset: 4,
  type: AnnotationType.COMMENT,
  text: id,
  originalText: 'Body',
  createdA: 1,
});

const DESIGN = '/project/docs/design.md';
const NOTES = '/project/docs/notes.md';

function transportServing(data: unknown): { transport: DraftTransport; removed: number[] } {
  const removed: number[] = [];
  return {
    removed,
    transport: {
      load: async () => ({ data, generation: null }),
      save: async () => {},
      remove: async (generation) => {
        removed.push(generation);
      },
    },
  };
}

type HookResult = ReturnType<typeof useAnnotationDraft>;

function Harness({ resultRef }: { resultRef: { current: HookResult | null } }) {
  resultRef.current = useAnnotationDraft({
    annotations: [],
    globalAttachments: [],
    isApiMode: true,
    isSharedSession: false,
    submitted: false,
  });
  return null;
}

async function mount(): Promise<{ result: { current: HookResult | null }; unmount: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const result: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={result} />);
  });
  await act(async () => new Promise<void>((r) => setTimeout(r, 30)));
  return {
    result,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('recovered draft with other documents', () => {
  test.skipIf(!hasDom)('the banner counts every document, and restore keeps each comment on its document', async () => {
    setDraftTransport(transportServing({
      annotations: [note('on-plan')],
      globalAttachments: [],
      documents: [
        { path: DESIGN, annotations: [note('on-design-1'), note('on-design-2')], globalAttachments: [] },
        { path: NOTES, annotations: [note('on-notes')], globalAttachments: [] },
      ],
      draftGeneration: 4,
      ts: Date.now(),
    }).transport);
    const session = await mount();

    expect(session.result.current!.draftBanner).toMatchObject({ count: 4, documents: 2 });

    let restored!: ReturnType<HookResult['restoreDraft']>;
    await act(async () => {
      restored = session.result.current!.restoreDraft();
    });
    expect(restored.annotations.map((a) => a.id)).toEqual(['on-plan']);
    expect(restored.documents.map((d) => [d.path, d.annotations.map((a) => a.id)])).toEqual([
      [DESIGN, ['on-design-1', 'on-design-2']],
      [NOTES, ['on-notes']],
    ]);
    await session.unmount();
  });

  test.skipIf(!hasDom)('only a linked document with comments still offers the draft', async () => {
    // The plan's own draft was emptied; the linked document's comments remain.
    setDraftTransport(transportServing({
      annotations: [],
      globalAttachments: [],
      documents: [{ path: DESIGN, annotations: [note('on-design')], globalAttachments: [] }],
      ts: Date.now(),
    }).transport);
    const session = await mount();
    expect(session.result.current!.draftBanner).toMatchObject({ count: 1, documents: 1 });
    await session.unmount();
  });

  test.skipIf(!hasDom)('dismissing hands back the documents it discarded', async () => {
    const served = transportServing({
      annotations: [note('on-plan')],
      globalAttachments: [],
      documents: [{ path: DESIGN, annotations: [note('on-design')], globalAttachments: [] }],
      ts: Date.now(),
    });
    setDraftTransport(served.transport);
    const session = await mount();

    let discarded: ReturnType<HookResult['dismissDraft']> = [];
    await act(async () => {
      discarded = session.result.current!.dismissDraft();
    });
    expect(discarded.map((d) => d.path)).toEqual([DESIGN]);
    expect(served.removed.length).toBe(1);
    expect(session.result.current!.draftBanner).toBeNull();
    await session.unmount();
  });

  test.skipIf(!hasDom)('a root-only draft keeps its banner exactly as before', async () => {
    setDraftTransport(transportServing({ annotations: [note('on-plan')], globalAttachments: [], ts: Date.now() }).transport);
    const session = await mount();
    expect(session.result.current!.draftBanner).toEqual({ count: 1, timeAgo: 'just now', hasEdits: false });
    await session.unmount();
  });
});
