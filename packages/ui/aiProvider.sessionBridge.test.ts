import { describe, expect, it } from 'bun:test';
import {
  resolveAIProviderSelection,
  resolveSessionBridgeFallback,
  type AIProviderOption,
  type AIProviderSettings,
} from './utils/aiProvider';

const settings = (overrides: Partial<AIProviderSettings> = {}): AIProviderSettings => ({
  providerId: null,
  preferredModels: {},
  providerByOrigin: {},
  ...overrides,
});

const piProviders = (status: 'ready' | 'busy' | 'blocked' | 'gone', transient = false): AIProviderOption[] => [
  { id: 'claude-local', name: 'claude-agent-sdk', models: [{ id: 'claude-default', label: 'Claude Default', default: true }] },
  { id: 'pi-sdk', name: 'pi-sdk', models: [{ id: 'pi-default', label: 'Pi Default', default: true }] },
  {
    id: 'session-bridge',
    name: 'session-bridge',
    label: 'Ask this session · Pi',
    models: [],
    sessionBridge: { host: 'pi', status, modes: { turn: true, transient } },
  },
];

describe('"Ask this session" default and fallback', () => {
  it('is the default over the origin SDK provider while the session can answer, busy included', () => {
    for (const status of ['ready', 'busy'] as const) {
      const selection = resolveAIProviderSelection({ providers: piProviders(status), origin: 'pi', settings: settings() });
      expect(selection).toEqual({ providerId: 'session-bridge', model: null });
    }
  });

  it('a saved per-origin pick still wins', () => {
    const selection = resolveAIProviderSelection({
      providers: piProviders('ready'),
      origin: 'pi',
      settings: settings({ providerByOrigin: { pi: 'pi-sdk' } }),
    });
    expect(selection.providerId).toBe('pi-sdk');
  });

  it('a saved global pick wins for an origin without its own provider', () => {
    const selection = resolveAIProviderSelection({
      providers: piProviders('ready'),
      origin: 'amp',
      settings: settings({ providerId: 'claude-local' }),
    });
    expect(selection.providerId).toBe('claude-local');
  });

  it('a gone session, or a blocked one without a transient mode, is not the default', () => {
    for (const providers of [piProviders('gone'), piProviders('blocked')]) {
      expect(resolveAIProviderSelection({ providers, origin: 'pi', settings: settings() }).providerId).toBe('pi-sdk');
    }
    expect(
      resolveAIProviderSelection({ providers: piProviders('blocked', true), origin: 'pi', settings: settings() }).providerId,
    ).toBe('session-bridge');
  });

  it('without a bridge the existing order is unchanged, even with a stale saved bridge pick', () => {
    const withoutBridge = piProviders('ready').filter((p) => !p.sessionBridge);
    expect(resolveAIProviderSelection({ providers: withoutBridge, origin: 'pi', settings: settings() }).providerId).toBe('pi-sdk');
    expect(
      resolveAIProviderSelection({
        providers: withoutBridge,
        origin: 'pi',
        settings: settings({ providerByOrigin: { pi: 'session-bridge' } }),
      }).providerId,
    ).toBe('pi-sdk');
  });

  it('the fallback is what the app would pick without the bridge, even when the bridge was saved', () => {
    const fallback = resolveSessionBridgeFallback({
      providers: piProviders('gone'),
      origin: 'pi',
      settings: settings({ providerByOrigin: { pi: 'session-bridge' } }),
      serverDefaultProvider: 'session-bridge',
    });
    expect(fallback).toEqual({ providerId: 'pi-sdk', model: 'pi-default' });
    const bridgeOnly = piProviders('gone').filter((p) => p.sessionBridge);
    expect(resolveSessionBridgeFallback({ providers: bridgeOnly, origin: 'pi', settings: settings() }).providerId).toBeNull();
  });
});
