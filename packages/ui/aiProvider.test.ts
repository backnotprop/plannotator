import { describe, expect, it } from 'bun:test';
import {
  applyAIProviderSelection,
  findOriginAIProvider,
  resolveAIProviderSelection,
  type AIProviderOption,
  type AIProviderSettings,
} from './utils/aiProvider';

const providers: AIProviderOption[] = [
  {
    id: 'claude-local',
    name: 'claude-agent-sdk',
    models: [
      { id: 'claude-default', label: 'Claude Default', default: true },
      { id: 'claude-alt', label: 'Claude Alt' },
    ],
  },
  {
    id: 'codex-local',
    name: 'codex-sdk',
    models: [
      { id: 'codex-default', label: 'Codex Default', default: true },
      { id: 'codex-alt', label: 'Codex Alt' },
    ],
  },
  { id: 'opencode-sdk', name: 'opencode-sdk' },
];

const settings = (overrides: Partial<AIProviderSettings> = {}): AIProviderSettings => ({
  providerId: null,
  preferredModels: {},
  providerByOrigin: {},
  ...overrides,
});

describe('AI provider origin defaults', () => {
  it('matches a detected origin by provider type even when registry IDs are custom', () => {
    expect(findOriginAIProvider(providers, 'claude-code')?.id).toBe('claude-local');
    expect(findOriginAIProvider(providers, 'codex')?.id).toBe('codex-local');
    expect(findOriginAIProvider(providers, 'opencode')?.id).toBe('opencode-sdk');
  });

  it('uses the origin-matched provider before the global saved provider', () => {
    const selection = resolveAIProviderSelection({
      providers,
      origin: 'codex',
      settings: settings({ providerId: 'claude-local' }),
    });

    expect(selection.providerId).toBe('codex-local');
    expect(selection.model).toBe('codex-default');
  });

  it('uses per-origin saved provider choices before the automatic origin match', () => {
    const selection = resolveAIProviderSelection({
      providers,
      origin: 'codex',
      settings: settings({
        providerByOrigin: { codex: 'claude-local' },
        preferredModels: { 'claude-local': 'claude-alt' },
      }),
    });

    expect(selection.providerId).toBe('claude-local');
    expect(selection.model).toBe('claude-alt');
  });

  it('falls back to server default when an origin has no matching provider', () => {
    const selection = resolveAIProviderSelection({
      providers,
      origin: 'gemini-cli',
      settings: settings(),
      serverDefaultProvider: 'codex-local',
    });

    expect(selection.providerId).toBe('codex-local');
  });

  it('stores explicit choices for mapped origins without changing the global fallback', () => {
    const next = applyAIProviderSelection(
      settings({ providerId: 'claude-local' }),
      { providerId: 'codex-local', model: 'codex-alt', origin: 'codex' },
    );

    expect(next.providerId).toBe('claude-local');
    expect(next.providerByOrigin.codex).toBe('codex-local');
    expect(next.preferredModels['codex-local']).toBe('codex-alt');
  });

  it('stores explicit choices as the global fallback for origins without a dedicated provider', () => {
    const next = applyAIProviderSelection(
      settings({ providerId: 'claude-local' }),
      { providerId: 'codex-local', model: 'codex-alt', origin: 'gemini-cli' },
    );

    expect(next.providerId).toBe('codex-local');
    expect(next.providerByOrigin['gemini-cli']).toBeUndefined();
  });
});
