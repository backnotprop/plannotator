import { describe, expect, it } from 'bun:test';
import {
  resolveAIProviderSelection,
  type AIProviderOption,
  type AIProviderSettings,
} from './utils/aiProvider';

const settings = (overrides: Partial<AIProviderSettings> = {}): AIProviderSettings => ({
  providerId: null,
  preferredModels: {},
  providerByOrigin: {},
  ...overrides,
});

const bridge = (status: 'ready' | 'busy' | 'blocked' | 'gone', transient = false): AIProviderOption => ({
  id: 'session-bridge',
  name: 'session-bridge',
  label: 'Ask this session · Claude Code',
  models: [],
  sessionBridge: { host: 'claude-code', status, modes: { turn: true, transient } },
});

const sdkProviders: AIProviderOption[] = [
  { id: 'claude-agent-sdk', name: 'claude-agent-sdk', models: [{ id: 'opus', label: 'Opus', default: true }] },
  { id: 'codex-sdk', name: 'codex-sdk', models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol', default: true }] },
  { id: 'pi-sdk', name: 'pi-sdk', models: [{ id: 'pi-default', label: 'Pi Default', default: true }] },
];

describe('"Ask this session" is the only Ask AI provider when present', () => {
  // The owner's case: Codex saved as the pick, then a Claude Code session with
  // the mod attached. The server offers only the bridge, and the saved pick must
  // not route the question elsewhere, whatever the session's status. (That the
  // cookie is left alone is pinned in aiProviderConfigPersistence.test.tsx.)
  it('a bridge-only answer selects the bridge over a saved codex pick, in every status', () => {
    const saved = settings({ providerId: 'codex-sdk', providerByOrigin: { 'claude-code': 'codex-sdk' } });
    for (const status of ['ready', 'busy', 'blocked', 'gone'] as const) {
      const selection = resolveAIProviderSelection({
        providers: [bridge(status)],
        origin: 'claude-code',
        settings: saved,
        serverDefaultProvider: 'session-bridge',
      });
      expect(selection).toEqual({ providerId: 'session-bridge', model: null });
    }
  });

  it('even listed beside SDK providers, the bridge wins over saved per-origin and global picks', () => {
    for (const [origin, saved] of [
      ['pi', settings({ providerByOrigin: { pi: 'pi-sdk' } })],
      ['amp', settings({ providerId: 'claude-agent-sdk' })],
    ] as const) {
      expect(
        resolveAIProviderSelection({ providers: [...sdkProviders, bridge('gone')], origin, settings: saved }).providerId,
      ).toBe('session-bridge');
    }
  });

  it('without a bridge the existing order is unchanged, even with a stale saved bridge pick', () => {
    expect(resolveAIProviderSelection({ providers: sdkProviders, origin: 'pi', settings: settings() }).providerId).toBe('pi-sdk');
    expect(
      resolveAIProviderSelection({
        providers: sdkProviders,
        origin: 'pi',
        settings: settings({ providerByOrigin: { pi: 'session-bridge' } }),
      }).providerId,
    ).toBe('pi-sdk');
    expect(
      resolveAIProviderSelection({
        providers: sdkProviders,
        origin: 'claude-code',
        settings: settings({ providerByOrigin: { 'claude-code': 'codex-sdk' } }),
      }),
    ).toEqual({ providerId: 'codex-sdk', model: 'gpt-6-sol' });
  });
});
