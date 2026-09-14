/**
 * Shared DOM harness for hook tests that need real React lifecycle
 * (mount/act/unmount) rather than a shallow renderer — e.g. asserting on a
 * hook's return value across re-renders. Previously copied wholesale
 * between useOriginFork.test.tsx and useAIChat.forkOrigin.test.tsx (#1519
 * review); this is the one place it's defined.
 *
 * Requires DOM — callers gate individual tests with `test.skipIf(!hasDom)`.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

export const hasDom = typeof document !== 'undefined';

export interface MountedHook<TResult> {
  /** Ref the harness component writes the hook's latest return value into. */
  result: { current: TResult | null };
  root: Root;
  host: HTMLDivElement;
  /** Re-render the host with new element/props (e.g. after a provider switch). */
  rerender: (element: React.ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * Mount `element` — typically a small harness component that stashes a
 * hook's return value into `resultRef.current` — into a detached host div,
 * wrapped in `act`.
 */
export async function mountHook<TResult>(
  resultRef: { current: TResult | null },
  element: React.ReactElement,
): Promise<MountedHook<TResult>> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  return {
    result: resultRef,
    root: root!,
    host,
    rerender: async (next) => {
      await act(async () => { root.render(next); });
    },
    unmount: async () => {
      await act(async () => { root!.unmount(); });
      host.remove();
    },
  };
}
