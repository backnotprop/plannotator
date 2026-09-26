import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  type CatalogModel,
  type ModelsSource,
} from '@plannotator/core/model-catalog';
import type { AgentCapabilities } from '../types';

// Picker helpers, re-exported for launch surfaces outside @plannotator/ui.
export { effortSelectOptions, modelSelectOptions } from '@plannotator/core/model-catalog';

/**
 * Claude / Codex model catalogs for the agent launchers (review, Code Tour,
 * Guided Review) — the SAME lists Ask AI shows. Each is the Ask AI provider's
 * discovered list, fetched through `/api/ai/capabilities?activate=<id>` (which
 * runs the provider's server-cached discovery). Nothing is fetched until a
 * surface asks for one engine with `useModelCatalogs(...).load(engine)`, and
 * only when that engine is installed, so opening a launcher spawns only the
 * selected CLI. While a fetch is in flight the static fallback is shown with
 * `settled: false`, so callers never reconcile saved picks against a list that
 * is merely loading; a failed fetch settles on the fallback and is retried the
 * next time a surface asks.
 */
export type CatalogEngine = 'claude' | 'codex';

export interface ModelCatalog {
  models: CatalogModel[];
  settled: boolean;
  /** Where the server says the list came from; absent when it did not say. */
  modelsSource?: ModelsSource;
  /** The installed CLI's version, when the server reports it. */
  toolVersion?: string;
}

type LoadedCatalog = Pick<ModelCatalog, 'models' | 'modelsSource' | 'toolVersion'>;

export interface ModelCatalogs extends Record<CatalogEngine, ModelCatalog> {
  /** Fetch one engine's catalog (no-op for other engines or when not installed). */
  load: (engine: string | null | undefined) => void;
}

const AI_PROVIDER_ID: Record<CatalogEngine, string> = {
  claude: 'claude-agent-sdk',
  codex: 'codex-sdk',
};

export const FALLBACK_MODELS: Record<CatalogEngine, CatalogModel[]> = {
  claude: CLAUDE_FALLBACK_MODELS,
  codex: CODEX_FALLBACK_MODELS,
};

const isCatalogEngine = (engine: unknown): engine is CatalogEngine => engine === 'claude' || engine === 'codex';

// One request per engine per page: every launcher surface shares the answer.
// A failed request is forgotten so the next load retries it.
const loads = new Map<CatalogEngine, Promise<LoadedCatalog>>();

function loadCatalogEntry(engine: CatalogEngine): Promise<LoadedCatalog> {
  let load = loads.get(engine);
  if (!load) {
    const id = AI_PROVIDER_ID[engine];
    const failed = (): LoadedCatalog => {
      loads.delete(engine);
      return { models: FALLBACK_MODELS[engine] };
    };
    load = fetch(`/api/ai/capabilities?activate=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data): LoadedCatalog => {
        const provider = data?.providers?.find((p: { id?: string; name?: string }) => p.id === id || p.name === id);
        const models = provider?.models;
        if (!Array.isArray(models) || models.length === 0) return failed();
        // The server answers 200 with its static fallback when discovery
        // failed; show it, but forget it so the next load retries (the
        // server's own cooldown bounds how often that spawns the CLI).
        if (provider.modelsSource === 'fallback') loads.delete(engine);
        return {
          models: models as CatalogModel[],
          ...(provider.modelsSource === 'fallback' || provider.modelsSource === 'discovered'
            ? { modelsSource: provider.modelsSource as ModelsSource }
            : {}),
          ...(typeof provider.toolVersion === 'string' && provider.toolVersion ? { toolVersion: provider.toolVersion } : {}),
        };
      })
      .catch(failed);
    loads.set(engine, load);
  }
  return load;
}

export function loadModelCatalog(engine: CatalogEngine): Promise<CatalogModel[]> {
  return loadCatalogEntry(engine).then((entry) => entry.models);
}

/** Test seam: forget cached catalogs. */
export function __resetModelCatalogsForTests(): void {
  loads.clear();
}

export function useModelCatalogs(capabilities: AgentCapabilities | null): ModelCatalogs {
  const available = (id: CatalogEngine) =>
    capabilities?.providers.some((p) => p.id === id && p.available) ?? false;
  const claudeOn = available('claude');
  const codexOn = available('codex');
  const [loaded, setLoaded] = useState<Partial<Record<CatalogEngine, LoadedCatalog>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    (engine: string | null | undefined) => {
      if (!isCatalogEngine(engine)) return;
      if (!(engine === 'claude' ? claudeOn : codexOn)) return;
      void loadCatalogEntry(engine).then((entry) => {
        if (mounted.current) setLoaded((prev) => (prev[engine] === entry ? prev : { ...prev, [engine]: entry }));
      });
    },
    [claudeOn, codexOn],
  );

  return useMemo(
    () => ({
      claude: loaded.claude ? { ...loaded.claude, settled: true } : { models: FALLBACK_MODELS.claude, settled: false },
      codex: loaded.codex ? { ...loaded.codex, settled: true } : { models: FALLBACK_MODELS.codex, settled: false },
      load,
    }),
    [loaded, load],
  );
}
