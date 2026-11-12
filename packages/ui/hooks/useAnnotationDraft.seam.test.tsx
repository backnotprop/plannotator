import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
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

function makeFakeTransport(): { transport: DraftTransport; state: { loaded: number; saved: object[] } } {
  const state = { loaded: 0, saved: [] as object[] };
  const transport: DraftTransport = {
    load: async () => {
      state.loaded++;
      return { data: null, generation: null };
    },
    save: async (body: object) => {
      state.saved.push(body);
    },
    remove: async () => {},
  };
  return { transport, state };
}

const ANNOTATION: Annotation = {
  id: 'ann-seam-1',
  blockId: 'block-1',
  startOffset: 0,
  endOffset: 4,
  type: AnnotationType.COMMENT,
  text: 'seam check',
  originalText: 'Test',
  createdA: Date.now(),
};

type HookOptions = Parameters<typeof useAnnotationDraft>[0];
type HookResult = ReturnType<typeof useAnnotationDraft>;

function Harness({ opts, resultRef }: { opts: HookOptions; resultRef: { current: HookResult | null } }) {
  resultRef.current = useAnnotationDraft(opts);
  return null;
}

async function mountHook(opts: HookOptions): Promise<{
  result: { current: HookResult | null };
  unmount: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness opts={opts} resultRef={resultRef} />);
  });
  return {
    result: resultRef,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

const tick = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));

describe('DraftTransport seam', () => {
  test.skipIf(!hasDom)('fake.load() is called on mount when isApiMode is true', async () => {
    const { transport, state } = makeFakeTransport();
    setDraftTransport(transport);

    const session = await mountHook({
      annotations: [],
      globalAttachments: [],
      isApiMode: true,
      isSharedSession: false,
      submitted: false,
    });

    await tick(50);

    expect(state.loaded).toBeGreaterThanOrEqual(1);

    await session.unmount();
  });

  test.skipIf(!hasDom)('fake.save() is called when scheduleDraftSave fires with annotations', async () => {
    const { transport, state } = makeFakeTransport();
    setDraftTransport(transport);

    const session = await mountHook({
      annotations: [ANNOTATION],
      globalAttachments: [],
      isApiMode: true,
      isSharedSession: false,
      submitted: false,
    });

    await tick(50);

    await act(async () => {
      session.result.current!.scheduleDraftSave();
    });

    await tick(600);

    expect(state.saved.length).toBeGreaterThanOrEqual(1);

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetDraftTransport restores the default (does not call the fake)', async () => {
    const { transport, state } = makeFakeTransport();
    setDraftTransport(transport);
    resetDraftTransport();

    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ found: false }), { status: 404 });
    }) as typeof fetch;

    const session = await mountHook({
      annotations: [],
      globalAttachments: [],
      isApiMode: true,
      isSharedSession: false,
      submitted: false,
    });

    await tick(50);

    globalThis.fetch = realFetch;

    expect(state.loaded).toBe(0);
    expect(fetchCalls.some((u) => u.includes('/api/draft'))).toBe(true);

    await session.unmount();
  });

  test.skipIf(!hasDom)('multi-target HTML annotations round-trip the draft transport verbatim', async () => {
    const MULTI_ANNOTATION: Annotation = {
      id: 'ann-multi-1',
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'Unify these',
      originalText: 'Primary chip',
      createdA: Date.now(),
      htmlAnchor: { selector: 'p.primary', tagName: 'p', text: 'Primary chip' },
      htmlAdditionalTargets: [
        {
          label: 'Button',
          text: 'Create',
          anchor: { selector: 'span.btn', tagName: 'span', text: 'Create' },
        },
        { label: 'rowchip', text: 'adopted by 1' },
      ],
    };

    const { transport, state } = makeFakeTransport();
    setDraftTransport(transport);
    const session = await mountHook({
      annotations: [MULTI_ANNOTATION],
      globalAttachments: [],
      isApiMode: true,
      isSharedSession: false,
      submitted: false,
    });
    await tick(50);
    await act(async () => {
      session.result.current!.scheduleDraftSave();
    });
    await tick(600);
    expect(state.saved.length).toBeGreaterThanOrEqual(1);
    const savedBody = state.saved.at(-1) as { annotations: Annotation[] };
    expect(savedBody.annotations[0]!.htmlAdditionalTargets)
      .toEqual(MULTI_ANNOTATION.htmlAdditionalTargets);
    await session.unmount();

    const restoreTransport: DraftTransport = {
      load: async () => ({
        data: {
          annotations: [MULTI_ANNOTATION],
          globalAttachments: [],
          ts: Date.now(),
        },
        generation: 1,
      }),
      save: async () => {},
      remove: async () => {},
    };
    setDraftTransport(restoreTransport);
    const restoreSession = await mountHook({
      annotations: [],
      globalAttachments: [],
      isApiMode: true,
      isSharedSession: false,
      submitted: false,
    });
    await tick(50);
    expect(restoreSession.result.current!.draftBanner?.count).toBe(1);
    const restored = restoreSession.result.current!.restoreDraft();
    expect(restored.annotations[0]!.htmlAdditionalTargets)
      .toEqual(MULTI_ANNOTATION.htmlAdditionalTargets);
    await restoreSession.unmount();
  });
});
