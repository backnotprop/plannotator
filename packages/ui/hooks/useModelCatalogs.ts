import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}

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
const loads = new Map<CatalogEngine, Promise<CatalogModel[]>>();

export function loadModelCatalog(engine: CatalogEngine): Promise<CatalogModel[]> {
  let load = loads.get(engine);
  if (!load) {
    const id = AI_PROVIDER_ID[engine];
    const failed = () => {
      loads.delete(engine);
      return FALLBACK_MODELS[engine];
    };
    load = fetch(`/api/ai/capabilities?activate=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const provider = data?.providers?.find((p: { id?: string; name?: string }) => p.id === id || p.name === id);
        const models = provider?.models;
        return Array.isArray(models) && models.length > 0 ? (models as CatalogModel[]) : failed();
      })
      .catch(failed);
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
      void loadModelCatalog(engine).then((models) => {
        if (mounted.current) setLoaded((prev) => (prev[engine] === models ? prev : { ...prev, [engine]: models }));
      });
    },
    [claudeOn, codexOn],
  );

  return useMemo(
    () => ({
      claude: { models: loaded.claude ?? FALLBACK_MODELS.claude, settled: !!loaded.claude },
      codex: { models: loaded.codex ?? FALLBACK_MODELS.codex, settled: !!loaded.codex },
      load,
    }),
    [loaded, load],
  );
}
