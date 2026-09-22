import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelCatalogs } from './useModelCatalogs';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useAgentSettings') : null;
const storage = hasDom ? await import('../utils/storage') : null;

type Settings = ReturnType<NonNullable<typeof hookModule>['useAgentSettings']>;

// A settled Codex catalog that no longer offers the saved model.
const catalogs: ModelCatalogs = {
  claude: { models: [], settled: false },
  codex: {
    models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', default: true, fastMode: true, reasoningEfforts: [{ id: 'high', label: 'High' }] }],
    settled: true,
  },
  load: () => {},
};

let latest: Settings | null = null;
function Harness() {
  latest = hookModule!.useAgentSettings(catalogs);
  return null;
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  storage?.resetStorageBackend();
});

describe.if(hasDom)('useAgentSettings Codex setters', () => {
  test('the Fast toggle applies when the saved model was replaced by the catalog default', async () => {
    // Saved pick is a model the catalog dropped; the picker shows gpt-6-sol.
    const memory = new Map<string, string>();
    storage!.setStorageBackend({
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    });
    storage!.setItem(
      'plannotator.agents',
      JSON.stringify({
        codex: { model: 'gpt-5.3-codex', perModel: {} },
        tourCodex: { model: 'gpt-5.3-codex', perModel: {} },
      }),
    );
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Harness />));
    expect(latest!.codexModel).toBe('gpt-6-sol');
    expect(latest!.codexFast).toBe(false);

    await act(async () => latest!.setCodexFast(true));
    // Before the fix the toggle wrote perModel['gpt-5.3-codex'] and did nothing.
    expect(latest!.codexFast).toBe(true);
    expect(latest!.codexModel).toBe('gpt-6-sol');

    await act(async () => latest!.setTourCodexFast(true));
    expect(latest!.tourCodexFast).toBe(true);
  });
});
