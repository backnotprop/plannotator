/**
 * Seam test: DraftTransport override (setDraftTransport / resetDraftTransport).
 *
 * Contract:
 *  - fake.load() is called on mount (isApiMode: true, not shared).
 *  - fake.save() is called after scheduleDraftSave() fires (annotations non-empty).
 *  - resetDraftTransport() restores the default transport (does not call the fake).
 *
 * Requires DOM — runs under bun test (preloaded via bunfig.toml).
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as useAnnotationDraftModule from './useAnnotationDraft';
import { AnnotationType, type Annotation } from '../types';
import type { DraftTransport } from './useAnnotationDraft';

// Capture real function references at import time.
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

    // Give the async load a moment to settle.
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

    await tick(50); // let the mount-load settle + hasMountedRef = true

    await act(async () => {
      session.result.current!.scheduleDraftSave();
    });

    // scheduleDraftSave has a 500 ms debounce; wait for it to fire.
    await tick(600);

    expect(state.saved.length).toBeGreaterThanOrEqual(1);

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetDraftTransport restores the default (does not call the fake)', async () => {
    const { transport, state } = makeFakeTransport();
    setDraftTransport(transport);
    resetDraftTransport();

    // After reset, the default transport hits /api/draft — install a fetch spy.
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

    // Fake was NOT called; the default transport hit /api/draft.
    expect(state.loaded).toBe(0);
    expect(fetchCalls.some((u) => u.includes('/api/draft'))).toBe(true);

    await session.unmount();
  });
});
