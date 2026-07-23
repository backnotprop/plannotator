import type { AgentCapabilities } from '@plannotator/ui/types';
import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import { useAgentSettings } from '@plannotator/ui/hooks/useAgentSettings';
import type { ReviewEngine } from '@plannotator/ui/hooks/useAgentSettings';
import { REVIEW_ENGINE_LABEL } from '@plannotator/ui/components/AgentsTab';

export const GUIDE_ENGINES = Object.keys(REVIEW_ENGINE_LABEL) as ReviewEngine[];

// Marker-engine fallbacks until the server delivers the live catalogs on the
// capability entries (mirrors AgentsTab's fallbacks).
const CURSOR_FALLBACK = [{ value: 'auto', label: 'Auto' }];
const OPENCODE_FALLBACK = [{ value: '', label: 'Default' }];
const PI_FALLBACK = [{ value: '', label: 'Default' }];
const COPILOT_FALLBACK = [{ value: '', label: 'Default' }];

export type GuideModelOption = { value: string; label: string };

export interface GuideLaunchState {
  /** The persisted agent settings bundle (pickers read/write through this). */
  settings: ReturnType<typeof useAgentSettings>;
  guideAvailable: boolean;
  availableEngines: ReviewEngine[];
  /** Effective engine: the persisted choice, snapped to an available one. */
  engine: ReviewEngine;
  cursorOptions: GuideModelOption[];
  opencodeOptions: GuideModelOption[];
  piOptions: GuideModelOption[];
  copilotOptions: GuideModelOption[];
  effectiveCursorModel: string;
  effectiveOpencodeModel: string;
  effectivePiModel: string;
  effectiveCopilotModel: string;
  /** Whether a guide launch can be attempted at all on this machine. */
  canLaunch: boolean;
  /** Build the launch params for the current effective engine + models. */
  buildParams: () => AgentLaunchParams;
}

/**
 * Shared guide-launch defaults: resolves the persisted engine/model settings
 * against the live capability catalogs and builds the exact AgentLaunchParams
 * shape the server expects (one shape per engine, mirroring AgentsTab's
 * buildGuideLaunch). Used by GuideEmptyState's Generate button and by
 * GuideView's "Regenerate" hint on an outdated saved guide, so both launch
 * surfaces stay in lockstep.
 */
export function useGuideLaunch(capabilities: AgentCapabilities | null): GuideLaunchState {
  const settings = useAgentSettings();
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
  // A persisted engine can be unavailable on this machine — fall back to the
  // first available one rather than a dead selection.
  const engine: ReviewEngine = providerAvailable(guideEngine) ? guideEngine : (availableEngines[0] ?? guideEngine);

  // Marker model catalogs are discovered server-side and delivered on the
  // capability entry; fall back to the engine-default option until then.
  // Mirrors AgentsTab's per-engine catalog semantics exactly: opencode/pi
  // PREPEND their engine-managed "Default" ('' value) to the discovered list —
  // the discovered catalogs are real models only, and dropping Default left a
  // saved-default user with a blank pill and no way back after picking a
  // concrete model. Cursor REPLACES: its discovered list natively includes
  // 'auto', so prepending would duplicate it.
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

  // A stale saved model id is reconciled at read time: if it's not in the
  // current catalog, fall back to the catalog's first entry rather than
  // POSTing a dead model id to the server. ('' / Default is present in the
  // opencode/pi catalogs after the prepend above, so a saved '' stays valid.)
  const effectiveModel = (saved: string, options: GuideModelOption[]): string =>
    options.some((o) => o.value === saved) ? saved : (options[0]?.value ?? saved);

  const effectiveCursorModel = effectiveModel(guideCursorModel, cursorOptions);
  const effectiveOpencodeModel = effectiveModel(guideOpencodeModel, opencodeOptions);
  const effectivePiModel = effectiveModel(guidePiModel, piOptions);
  const effectiveCopilotModel = effectiveModel(guideCopilotModel, copilotOptions);

  // Config shapes mirror AgentsTab's buildGuideLaunch exactly — one shape
  // per engine, so the server sees identical launches from every surface.
  const buildParams = (): AgentLaunchParams =>
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

  return {
    settings,
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
    canLaunch: guideAvailable && availableEngines.length > 0,
    buildParams,
  };
}
