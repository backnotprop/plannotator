/**
 * AI Provider Settings Utility
 *
 * Manages the user's default AI provider and per-provider model preferences.
 * Uses cookies (not localStorage) because each hook invocation runs on a
 * random port, and localStorage is scoped by origin including port.
 */

import { storage } from './storage';
import { AGENT_CONFIG, getAgentAIProviderTypes, type Origin } from '@plannotator/core/agents';
import { resolveModelChoice, type CatalogModel } from '@plannotator/core/model-catalog';

const PROVIDER_KEY = 'plannotator-ai-provider';
const MODELS_KEY = 'plannotator-ai-models';
const PROVIDER_BY_ORIGIN_KEY = 'plannotator-ai-provider-by-origin';

/** A provider-reported model — the shared catalog shape. */
export type AIProviderModel = CatalogModel;

export interface AIProviderOption {
  id: string;
  name: string;
  models?: AIProviderModel[];
}

export interface AIProviderSettings {
  /** The provider instance ID to use, or null for server default. */
  providerId: string | null;
  /** Preferred model per provider. Key = provider instance ID, value = model ID. */
  preferredModels: Record<string, string>;
  /** Preferred provider per detected agent origin. Key = Origin, value = provider instance ID. */
  providerByOrigin: Partial<Record<Origin, string>>;
}

export interface AIProviderSelection {
  providerId: string | null;
  model: string | null;
}

export function originHasDedicatedAIProvider(origin: Origin | null | undefined): boolean {
  return getAgentAIProviderTypes(origin).length > 0;
}

/**
 * Get current AI provider settings from storage
 */
export function getAIProviderSettings(): AIProviderSettings {
  const providerId = storage.getItem(PROVIDER_KEY) || null;
  let preferredModels: Record<string, string> = {};
  let providerByOrigin: Partial<Record<Origin, string>> = {};
  try {
    const raw = storage.getItem(MODELS_KEY);
    if (raw) preferredModels = JSON.parse(raw);
  } catch {
    // Invalid JSON — start fresh
  }
  try {
    const raw = storage.getItem(PROVIDER_BY_ORIGIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [origin, value] of Object.entries(parsed)) {
          if (origin in AGENT_CONFIG && typeof value === 'string') {
            providerByOrigin[origin as Origin] = value;
          }
        }
      }
    }
  } catch {
    // Invalid JSON — start fresh
  }
  return { providerId, preferredModels, providerByOrigin };
}

/**
 * Save AI provider settings to storage
 */
export function saveAIProviderSettings(settings: AIProviderSettings): void {
  if (settings.providerId) {
    storage.setItem(PROVIDER_KEY, settings.providerId);
  } else {
    storage.removeItem(PROVIDER_KEY);
  }
  storage.setItem(MODELS_KEY, JSON.stringify(settings.preferredModels));
  const providerByOrigin = settings.providerByOrigin ?? {};
  if (Object.keys(providerByOrigin).length > 0) {
    storage.setItem(PROVIDER_BY_ORIGIN_KEY, JSON.stringify(providerByOrigin));
  } else {
    storage.removeItem(PROVIDER_BY_ORIGIN_KEY);
  }
}

/**
 * Get the preferred model for a specific provider
 */
export function getPreferredModel(providerId: string): string | null {
  const { preferredModels } = getAIProviderSettings();
  return preferredModels[providerId] ?? null;
}

/**
 * Save the preferred model for a specific provider (without changing other preferences)
 */
export function savePreferredModel(providerId: string, modelId: string): void {
  const settings = getAIProviderSettings();
  settings.preferredModels[providerId] = modelId;
  saveAIProviderSettings(settings);
}

/**
 * Find the first available provider that naturally matches the current origin.
 * Instance IDs can be custom, so we match both the registry ID and provider type.
 */
export function findOriginAIProvider(
  providers: AIProviderOption[],
  origin: Origin | null | undefined,
): AIProviderOption | null {
  const providerTypes = getAgentAIProviderTypes(origin);
  for (const providerType of providerTypes) {
    const provider = providers.find(p => p.id === providerType || p.name === providerType);
    if (provider) return provider;
  }
  return null;
}

export function resolveAIModelForProvider(
  provider: AIProviderOption | null | undefined,
  preferredModels: Record<string, string>,
): string | null {
  if (!provider) return null;
  const models = provider.models ?? [];
  const preferredModel = preferredModels[provider.id] ?? '';
  // Providers that report no models take the saved pick verbatim; otherwise
  // the shared resolver (same one the server and the launchers use).
  if (models.length === 0) return preferredModel || null;
  return resolveModelChoice(preferredModel, models) || null;
}

export function resolveAIProviderSelection(options: {
  providers: AIProviderOption[];
  origin?: Origin | null;
  settings?: AIProviderSettings;
  serverDefaultProvider?: string | null;
}): AIProviderSelection {
  const { providers, origin, serverDefaultProvider } = options;
  const settings = options.settings ?? getAIProviderSettings();
  if (providers.length === 0) return { providerId: null, model: null };

  const byId = (id: string | null | undefined) =>
    id ? providers.find(provider => provider.id === id) ?? null : null;

  const provider =
    byId(origin ? settings.providerByOrigin[origin] : null) ??
    findOriginAIProvider(providers, origin) ??
    byId(settings.providerId) ??
    byId(serverDefaultProvider) ??
    providers[0] ??
    null;

  return {
    providerId: provider?.id ?? null,
    model: resolveAIModelForProvider(provider, settings.preferredModels),
  };
}

export function saveAIProviderSelection(options: {
  providerId: string | null;
  model?: string | null;
  origin?: Origin | null;
  settings?: AIProviderSettings;
}): void {
  const settings = options.settings ?? getAIProviderSettings();
  saveAIProviderSettings(applyAIProviderSelection(settings, options));
}

export function applyAIProviderSelection(
  settings: AIProviderSettings,
  options: {
    providerId: string | null;
    model?: string | null;
    origin?: Origin | null;
  },
): AIProviderSettings {
  const preferredModels = { ...settings.preferredModels };
  if (options.providerId && options.model) {
    preferredModels[options.providerId] = options.model;
  }

  const providerByOrigin = { ...settings.providerByOrigin };
  let providerId = settings.providerId;
  const hasOriginDefault = originHasDedicatedAIProvider(options.origin);

  if (options.origin && hasOriginDefault) {
    if (options.providerId) {
      providerByOrigin[options.origin] = options.providerId;
    } else {
      delete providerByOrigin[options.origin];
    }
  } else {
    providerId = options.providerId;
  }

  return {
    ...settings,
    providerId,
    preferredModels,
    providerByOrigin,
  };
}
