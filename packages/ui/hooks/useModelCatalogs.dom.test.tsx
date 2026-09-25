import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentCapabilities } from '../types';
import type { ModelCatalogs } from './useModelCatalogs';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useModelCatalogs') : null;

const capabilities: AgentCapabilities = {
  mode: 'review',
  available: true,
  providers: [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex CLI', available: true },
  ],
};

function Harness({ engine }: { engine: string }) {
  const catalogs = hookModule!.useModelCatalogs(capabilities);
  useEffect(() => catalogs.load(engine), [catalogs.load, engine]);
  return null;
}

const realFetch = globalThis.fetch;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  hookModule?.__resetModelCatalogsForTests();
});

describe.if(hasDom)('useModelCatalogs', () => {
  test('fetches only the catalog of the engine a surface asks for', async () => {
    // Every catalog fetch spawns that CLI server-side, so a Claude launcher
    // must never start `codex app-server` (or the other way round).
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ available: true, providers: [] });
    }) as typeof fetch;

    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Harness engine="claude" />));
    await act(async () => root!.render(<Harness engine="cursor" />));
    expect(urls).toEqual(['/api/ai/capabilities?activate=claude-agent-sdk']);
  });

  test("carries the server's list source and tool version to the launchers' hint", async () => {
    const seen: ModelCatalogs[] = [];
    function Probe() {
      const catalogs = hookModule!.useModelCatalogs(capabilities);
      seen.push(catalogs);
      useEffect(() => catalogs.load('codex'), [catalogs.load]);
      return null;
    }
    globalThis.fetch = (async () =>
      Response.json({
        available: true,
        providers: [{ id: 'codex-sdk', models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }], modelsSource: 'discovered', toolVersion: '0.155.1' }],
      })) as unknown as typeof fetch;

    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    const codex = seen[seen.length - 1].codex;
    expect(codex.settled).toBe(true);
    expect(codex.modelsSource).toBe('discovered');
    expect(codex.toolVersion).toBe('0.155.1');
    // Claude was never loaded: no source claimed for it.
    expect(seen[seen.length - 1].claude.toolVersion).toBeUndefined();
  });
});
