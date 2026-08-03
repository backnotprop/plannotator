/**
 * Seam test: FileTreeBackend override (setFileTreeBackend / resetFileTreeBackend).
 *
 * Contract: after setFileTreeBackend(fake), useFileBrowser.fetchTree() calls
 * fake.loadTree(dirPath) instead of /api/reference/files.
 * resetFileTreeBackend() restores the default.
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
import * as useFileBrowserModule from './useFileBrowser';

// Capture real function references at import time.
const setFileTreeBackend = useFileBrowserModule.setFileTreeBackend;
const resetFileTreeBackend = useFileBrowserModule.resetFileTreeBackend;
const useFileBrowser = useFileBrowserModule.useFileBrowser;
type UseFileBrowserReturn = useFileBrowserModule.UseFileBrowserReturn;
type FileTreeBackend = useFileBrowserModule.FileTreeBackend;

const hasDom = typeof document !== 'undefined';
const realEventSource = (globalThis as Record<string, unknown>).EventSource;

afterEach(() => {
  resetFileTreeBackend();
  if (hasDom) document.body.innerHTML = '';
  if (realEventSource !== undefined) {
    (globalThis as Record<string, unknown>).EventSource = realEventSource;
  } else {
    delete (globalThis as Record<string, unknown>).EventSource;
  }
});

function Harness({ resultRef }: { resultRef: { current: UseFileBrowserReturn | null } }) {
  resultRef.current = useFileBrowser();
  return null;
}

async function mountHook(): Promise<{
  result: { current: UseFileBrowserReturn | null };
  unmount: () => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: UseFileBrowserReturn | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={resultRef} />);
  });
  return {
    result: resultRef,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

// Suppress EventSource so the watcher branch doesn't open a live stream
// and cause interference.
function suppressEventSource() {
  (globalThis as Record<string, unknown>).EventSource = undefined;
}

describe('FileTreeBackend seam', () => {
  test.skipIf(!hasDom)('fake.loadTree is called with the expected dirPath', async () => {
    suppressEventSource();
    const loadTreeCalls: string[] = [];
    const dirPath = '/repo/docs';
    const fakeBackend: FileTreeBackend = {
      loadTree: async (path: string) => {
        loadTreeCalls.push(path);
        return new Response(JSON.stringify({ tree: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      loadVaultTree: async () => new Response(JSON.stringify({ tree: [] }), { status: 200 }),
      watchTrees: () => undefined,
    };

    setFileTreeBackend(fakeBackend);

    const session = await mountHook();

    await act(async () => {
      await (session.result.current!.fetchTree(dirPath) as unknown as Promise<void>);
    });

    expect(loadTreeCalls).toContain(dirPath);

    await session.unmount();
  });

  test.skipIf(!hasDom)('resetFileTreeBackend restores the default (does not call the fake)', async () => {
    suppressEventSource();
    const fakeCalls: string[] = [];
    const fakeBackend: FileTreeBackend = {
      loadTree: async (path: string) => { fakeCalls.push(path); return new Response('{}', { status: 200 }); },
      loadVaultTree: async () => new Response('{}', { status: 200 }),
      watchTrees: () => undefined,
    };

    setFileTreeBackend(fakeBackend);
    resetFileTreeBackend();

    // After reset, the default backend calls fetch(/api/reference/files...).
    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const session = await mountHook();

    await act(async () => {
      await (session.result.current!.fetchTree('/some/dir') as unknown as Promise<void>);
    });

    globalThis.fetch = realFetch;

    // The fake was NOT consulted; the default backend hit /api/reference/files.
    expect(fakeCalls).toHaveLength(0);
    expect(fetchCalls.some((u) => u.includes('/api/reference/files'))).toBe(true);

    await session.unmount();
  });
});
