import { useEffect, useMemo, useState } from 'react';
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  type CatalogModel,
} from '@plannotator/core/model-catalog';
import type { AgentCapabilities } from '../types';

// Picker helpers, re-exported for launch surfaces outside @plannotator/ui.
export { effortSelectOptions, modelSelectOptions } from '@plannotator/core/model-catalog';

/**
 * Claude / Codex model catalogs for the agent launchers (review, Code Tour,
 * Guided Review) — the SAME lists Ask AI shows. Each is the Ask AI provider's
 * discovered list, fetched through `/api/ai/capabilities?activate=<id>` (which
 * runs the provider's one-time, server-cached discovery) the first time a
 * launcher needs it, and only when that engine is installed. While the fetch
 * is in flight the static fallback is shown with `settled: false`, so callers
 * never reconcile saved picks against a list that is merely loading; a failed
 * fetch settles on the fallback.
 */
export type CatalogEngine = 'claude' | 'codex';

export interface ModelCatalog {
  models: CatalogModel[];
  settled: boolean;
}

export type ModelCatalogs = Record<CatalogEngine, ModelCatalog>;

const AI_PROVIDER_ID: Record<CatalogEngine, string> = {
  claude: 'claude-agent-sdk',
  codex: 'codex-sdk',
};

export const FALLBACK_MODELS: Record<CatalogEngine, CatalogModel[]> = {
  claude: CLAUDE_FALLBACK_MODELS,
  codex: CODEX_FALLBACK_MODELS,
};

// One request per engine per page: every launcher surface shares the answer.
const loads = new Map<CatalogEngine, Promise<CatalogModel[]>>();

export function loadModelCatalog(engine: CatalogEngine): Promise<CatalogModel[]> {
  let load = loads.get(engine);
  if (!load) {
    const id = AI_PROVIDER_ID[engine];
    load = fetch(`/api/ai/capabilities?activate=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const provider = data?.providers?.find((p: { id?: string; name?: string }) => p.id === id || p.name === id);
        const models = provider?.models;
        return Array.isArray(models) && models.length > 0 ? (models as CatalogModel[]) : FALLBACK_MODELS[engine];
      })
      .catch(() => FALLBACK_MODELS[engine]);
    loads.set(engine, load);
  }
  return load;
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
  const [loaded, setLoaded] = useState<Partial<Record<CatalogEngine, CatalogModel[]>>>({});

  useEffect(() => {
    let alive = true;
    for (const [engine, on] of [['claude', claudeOn], ['codex', codexOn]] as const) {
      if (!on) continue;
      void loadModelCatalog(engine).then((models) => {
        if (alive) setLoaded((prev) => (prev[engine] === models ? prev : { ...prev, [engine]: models }));
      });
    }
    return () => {
      alive = false;
    };
  }, [claudeOn, codexOn]);

  return useMemo(
    () => ({
      claude: { models: loaded.claude ?? FALLBACK_MODELS.claude, settled: !!loaded.claude },
      codex: { models: loaded.codex ?? FALLBACK_MODELS.codex, settled: !!loaded.codex },
    }),
    [loaded],
  );
}
