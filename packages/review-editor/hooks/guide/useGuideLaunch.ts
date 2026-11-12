import type { AgentCapabilities } from '@plannotator/ui/types';
import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import { useEffect } from 'react';
import { useAgentSettings } from '@plannotator/ui/hooks/useAgentSettings';
import { useModelCatalogs, type ModelCatalogs } from '@plannotator/ui/hooks/useModelCatalogs';
import type { ReviewEngine } from '@plannotator/ui/hooks/useAgentSettings';
import { REVIEW_ENGINE_LABEL } from '@plannotator/ui/components/AgentsTab';

export const GUIDE_ENGINES = Object.keys(REVIEW_ENGINE_LABEL) as ReviewEngine[];

const CURSOR_FALLBACK = [{ value: 'auto', label: 'Auto' }];
const OPENCODE_FALLBACK = [{ value: '', label: 'Default' }];
const PI_FALLBACK = [{ value: '', label: 'Default' }];
const COPILOT_FALLBACK = [{ value: '', label: 'Default' }];

export type GuideModelOption = { value: string; label: string };

export interface GuideLaunchState {
  settings: ReturnType<typeof useAgentSettings>;
  catalogs: ModelCatalogs;
  guideAvailable: boolean;
  availableEngines: ReviewEngine[];
  engine: ReviewEngine;
  cursorOptions: GuideModelOption[];
  opencodeOptions: GuideModelOption[];
  piOptions: GuideModelOption[];
  copilotOptions: GuideModelOption[];
  effectiveCursorModel: string;
  effectiveOpencodeModel: string;
  effectivePiModel: string;
  effectiveCopilotModel: string;
  canLaunch: boolean;
  buildParams: (instructions?: string) => AgentLaunchParams;
}

export function useGuideLaunch(
  capabilities: AgentCapabilities | null,
  { loadModels = true }: { loadModels?: boolean } = {},
): GuideLaunchState {
  const catalogs = useModelCatalogs(capabilities);
  const settings = useAgentSettings(catalogs);
  const {
    guideEngine,
    guideClaudeModel,
    guideClaudeEffort,
    guideCodexModel,
    guideCodexReasoning,
    guideCursorModel,
    guideOpencodeModel,
    guidePiModel,
    guidePiThinking,
    guideCopilotModel,
  } = settings;

  const providerAvailable = (id: string) =>
    capabilities?.providers.some((p) => p.id === id && p.available) ?? false;
  const guideAvailable = providerAvailable('guide');
  const availableEngines = GUIDE_ENGINES.filter(providerAvailable);
  const engine: ReviewEngine = providerAvailable(guideEngine) ? guideEngine : (availableEngines[0] ?? guideEngine);
  const loadCatalog = catalogs.load;
  useEffect(() => {
    if (loadModels) loadCatalog(engine);
  }, [loadModels, loadCatalog, engine]);

  const markerModels = (id: 'cursor' | 'opencode' | 'pi' | 'copilot', fallback: GuideModelOption[]): GuideModelOption[] => {
    const models = capabilities?.providers.find((p) => p.id === id)?.models;
    if (!models || models.length === 0) return fallback;
    const discovered = models.map((m) => ({ value: m.id, label: m.label }));
    return id === 'cursor' ? discovered : [...fallback, ...discovered];
  };

  const cursorOptions = markerModels('cursor', CURSOR_FALLBACK);
  const opencodeOptions = markerModels('opencode', OPENCODE_FALLBACK);
  const piOptions = markerModels('pi', PI_FALLBACK);
  const copilotOptions = markerModels('copilot', COPILOT_FALLBACK);

  // A stale saved model id falls back to the catalog's first entry rather than POSTing a dead id.
  const effectiveModel = (saved: string, options: GuideModelOption[]): string =>
    options.some((o) => o.value === saved) ? saved : (options[0]?.value ?? saved);

  const effectiveCursorModel = effectiveModel(guideCursorModel, cursorOptions);
  const effectiveOpencodeModel = effectiveModel(guideOpencodeModel, opencodeOptions);
  const effectivePiModel = effectiveModel(guidePiModel, piOptions);
  const effectiveCopilotModel = effectiveModel(guideCopilotModel, copilotOptions);

  const buildParams = (instructions?: string): AgentLaunchParams => {
    const live = instructions?.trim();
    const params = buildEngineParams();
    return live ? { ...params, instructions: live } : params;
  };

  const buildEngineParams = (): AgentLaunchParams =>
    engine === 'cursor'
      ? {
          provider: 'guide',
          label: 'Guided Review',
          engine: 'cursor',
          ...(effectiveCursorModel && effectiveCursorModel.toLowerCase() !== 'auto' ? { model: effectiveCursorModel } : {}),
        }
      : engine === 'opencode'
        ? {
            provider: 'guide',
            label: 'Guided Review',
            engine: 'opencode',
            ...(effectiveOpencodeModel ? { model: effectiveOpencodeModel } : {}),
          }
        : engine === 'pi'
          ? {
              provider: 'guide',
              label: 'Guided Review',
              engine: 'pi',
              ...(effectivePiModel ? { model: effectivePiModel } : {}),
              thinking: guidePiThinking,
            }
          : engine === 'copilot'
            ? {
                provider: 'guide',
                label: 'Guided Review',
                engine: 'copilot',
                ...(effectiveCopilotModel ? { model: effectiveCopilotModel } : {}),
              }
            : {
                provider: 'guide',
                label: 'Guided Review',
                engine,
                model: engine === 'claude' ? guideClaudeModel : guideCodexModel,
                ...(engine === 'claude'
                  ? { effort: guideClaudeEffort }
                  : { reasoningEffort: guideCodexReasoning }),
              };

  // Claude/Codex launches wait for their catalog to settle so a launch never
  // uses an unresolved pick (the catalog always settles; fallback on failure).
  const modelsReady = engine === 'claude' || engine === 'codex' ? catalogs[engine].settled : true;

  return {
    settings,
    catalogs,
    guideAvailable,
    availableEngines,
    engine,
    cursorOptions,
    opencodeOptions,
    piOptions,
    copilotOptions,
    effectiveCursorModel,
    effectiveOpencodeModel,
    effectivePiModel,
    effectiveCopilotModel,
    canLaunch: guideAvailable && availableEngines.length > 0 && modelsReady,
    buildParams,
  };
}
