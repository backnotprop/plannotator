/**
 * Persistence tests for the shared AI provider/model selection hook.
 *
 * Guards the "saved preference no-clobber" invariant: with Codex model
 * discovery deferred until activation, capabilities can advertise only the
 * provider's static fallback model. The hook then resolves the *session*
 * model to that fallback, but must never write the resolver-derived fallback
 * back into the saved per-provider preference — only an explicit user pick
 * may change the cookie.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test aiProviderConfigPersistence
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useAIProviderConfig } from './hooks/useAIProviderConfig';
import {
  getAIProviderSettings,
  saveAIProviderSettings,
  type AIProviderOption,
} from './utils/aiProvider';
import { setStorageBackend, resetStorageBackend, type StorageBackend } from './utils/storage';

const hasDom = typeof document !== 'undefined';

// In-memory storage so tests don't depend on happy-dom cookie semantics.
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

type HookResult = ReturnType<typeof useAIProviderConfig>;

function Harness(props: {
  providers: AIProviderOption[];
  onRender: (result: HookResult) => void;
}) {
  const result = useAIProviderConfig({
    providers: props.providers,
    defaultProvider: 'codex-local',
    available: true,
    origin: null,
  });
  useEffect(() => {
    props.onRender(result);
  });
  return null;
}

// Capabilities before deferred discovery: only the static fallback model.
const fallbackOnlyProviders: AIProviderOption[] = [
  {
    id: 'codex-local',
    name: 'codex-sdk',
    models: [{ id: 'gpt-5.6-sol', label: 'GPT Fallback', default: true }],
  },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mountHarness(providers: AIProviderOption[]): Promise<() => HookResult> {
  let latest: HookResult | null = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness providers={providers} onRender={(r) => { latest = r; }} />);
  });
  return () => {
    if (!latest) throw new Error('Harness did not render');
    return latest;
  };
}

async function unmountHarness() {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
}

beforeEach(async () => {
  await unmountHarness();
  memory.clear();
  if (hasDom) setStorageBackend(memoryBackend);
});

afterAll(async () => {
  await unmountHarness();
  resetStorageBackend();
});

describe('useAIProviderConfig persistence', () => {
  test.skipIf(!hasDom)('does not persist an automatically resolved provider or fallback model', async () => {
    const getResult = await mountHarness(fallbackOnlyProviders);

    expect(getResult().aiConfig.providerId).toBe('codex-local');
    expect(getResult().aiConfig.model).toBe('gpt-5.6-sol');

    const persisted = getAIProviderSettings();
    expect(persisted.providerId).toBeNull();
    expect(persisted.providerByOrigin).toEqual({});
    expect(persisted.preferredModels['codex-local']).toBeUndefined();
  });

  test.skipIf(!hasDom)('a resolver-derived fallback model is not persisted over the saved preference', async () => {
    // The user's real Codex model preference, saved from a prior session —
    // not present in the pre-activation fallback list.
    saveAIProviderSettings({
      providerId: 'codex-local',
      preferredModels: { 'codex-local': 'gpt-5.3-codex' },
      providerByOrigin: {},
    });

    const getResult = await mountHarness(fallbackOnlyProviders);

    // Session-facing state falls back to the advertised model...
    expect(getResult().aiConfig.providerId).toBe('codex-local');
    expect(getResult().aiConfig.model).toBe('gpt-5.6-sol');

    // ...and a non-model change (reasoning effort) persists without touching
    // the saved model preference.
    await act(async () => {
      getResult().applyConfigChange({ reasoningEffort: 'high' });
    });

    expect(getAIProviderSettings().preferredModels['codex-local']).toBe('gpt-5.3-codex');
  });

  test.skipIf(!hasDom)('a provider switch does not overwrite the saved model preference either', async () => {
    saveAIProviderSettings({
      providerId: 'codex-local',
      preferredModels: { 'codex-local': 'gpt-5.3-codex' },
      providerByOrigin: {},
    });

    const providers: AIProviderOption[] = [
      ...fallbackOnlyProviders,
      {
        id: 'claude-local',
        name: 'claude-agent-sdk',
        models: [{ id: 'claude-default', label: 'Claude Default', default: true }],
      },
    ];
    const getResult = await mountHarness(providers);

    // Switch away and back: both are provider-only gestures.
    await act(async () => {
      getResult().applyConfigChange({ providerId: 'claude-local' });
    });
    await act(async () => {
      getResult().applyConfigChange({ providerId: 'codex-local' });
    });

    const persisted = getAIProviderSettings();
    expect(persisted.preferredModels['codex-local']).toBe('gpt-5.3-codex');
    expect(persisted.providerId).toBe('codex-local');
  });

  test.skipIf(!hasDom)('an explicit model pick is persisted', async () => {
    saveAIProviderSettings({
      providerId: 'codex-local',
      preferredModels: { 'codex-local': 'gpt-5.3-codex' },
      providerByOrigin: {},
    });

    const getResult = await mountHarness(fallbackOnlyProviders);

    await act(async () => {
      getResult().applyConfigChange({ model: 'gpt-5.6-sol' });
    });

    expect(getAIProviderSettings().preferredModels['codex-local']).toBe('gpt-5.6-sol');
  });
});
