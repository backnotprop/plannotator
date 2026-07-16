/**
 * Seam test: ExternalAnnotationTransport override
 *   (setExternalAnnotationTransport / resetExternalAnnotationTransport).
 *
 * Contract:
 *  - On mount (enabled: true) → fake.subscribe() is called.
 *  - deleteExternalAnnotation() → fake.remove() called on the SAME transport
 *    instance (pins the already-landed split-transport fix: transportRef captures
 *    the transport once at mount, so CRUD and subscribe use the same backend).
 *  - resetExternalAnnotationTransport() restores the default.
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
import * as useExternalAnnotationsModule from './useExternalAnnotations';
import type { ExternalAnnotationTransport } from './useExternalAnnotations';

// Capture real function references at import time.
const setExternalAnnotationTransport = useExternalAnnotationsModule.setExternalAnnotationTransport;
const resetExternalAnnotationTransport = useExternalAnnotationsModule.resetExternalAnnotationTransport;
const useExternalAnnotations = useExternalAnnotationsModule.useExternalAnnotations;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetExternalAnnotationTransport();
  if (hasDom) document.body.innerHTML = '';
});

type TestAnnotation = { id: string; source?: string };

type HookResult = ReturnType<typeof useExternalAnnotations<TestAnnotation>>;

function Harness({
  resultRef,
  enabled = true,
}: {
  resultRef: { current: HookResult | null };
  enabled?: boolean;
}) {
  resultRef.current = useExternalAnnotations<TestAnnotation>({ enabled });
  return null;
}

async function mountHook(enabled = true): Promise<{
  result: { current: HookResult | null };
  unmount: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={resultRef} enabled={enabled} />);
  });
  return {
    result: resultRef,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

describe('ExternalAnnotationTransport seam', () => {
  test.skipIf(!hasDom)('fake.subscribe() is called on mount when enabled', async () => {
    const subscribeCalls: number[] = [];

    const fakeTransport: ExternalAnnotationTransport<TestAnnotation> = {
      subscribe: (_onEvent, _onError) => {
        subscribeCalls.push(1);
        return () => {};
      },
      getSnapshot: async () => null,
      add: async () => {},
      remove: async () => {},
      update: async () => {},
      clear: async () => {},
    };

    setExternalAnnotationTransport(fakeTransport);

    const session = await mountHook();

    expect(subscribeCalls.length).toBeGreaterThanOrEqual(1);

    await session.unmount();
  });

  test.skipIf(!hasDom)('fake.remove() is called on the SAME transport instance (split-transport fix)', async () => {
    const removeIds: string[] = [];

    const fakeTransport: ExternalAnnotationTransport<TestAnnotation> = {
      subscribe: (_onEvent, _onError) => () => {},
      getSnapshot: async () => null,
      add: async () => {},
      remove: async (id) => { removeIds.push(id); },
      update: async () => {},
      clear: async () => {},
    };

    setExternalAnnotationTransport(fakeTransport);

    const session = await mountHook();

    await act(async () => {
      session.result.current!.deleteExternalAnnotation('annotation-id-1');
    });

    expect(removeIds).toContain('annotation-id-1');

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetExternalAnnotationTransport restores the default (does not call the fake)', async () => {
    const subscribeCalls: number[] = [];
    const fake: ExternalAnnotationTransport<TestAnnotation> = {
      subscribe: () => { subscribeCalls.push(1); return () => {}; },
      getSnapshot: async () => null,
      add: async () => {},
      remove: async () => {},
      update: async () => {},
      clear: async () => {},
    };

    setExternalAnnotationTransport(fake);
    resetExternalAnnotationTransport();

    // Replace EventSource so the default SSE transport does not error.
    class FakeEventSource {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      close() {}
    }
    const prevES = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;

    const session = await mountHook();

    (globalThis as Record<string, unknown>).EventSource = prevES;

    // The fake must NOT have been subscribed; the reset reinstalled the default.
    expect(subscribeCalls).toHaveLength(0);

    await session.unmount();
  });
});
