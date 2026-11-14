import { useCallback, useEffect, useMemo, useState } from 'react';
import { GUIDE_ENGINE_LABEL } from '@plannotator/core/guide';
import {
  EFFORT_LABELS,
  effortSelectOptions,
  modelFallbackNotice,
  modelLabel,
  modelSelectOptions,
  PI_THINKING_LEVELS,
} from '@plannotator/core/model-catalog';
import type { AgentCapabilities } from '../types';
import { useAgentSettings, type ReviewEngine } from './useAgentSettings';
import { useModelCatalogs, type ModelCatalogs } from './useModelCatalogs';
import type { AgentLaunchParams } from './useAgentJobs';

export type LaunchKind = 'review' | 'guide';
export type LaunchChoice = { value: string; label: string };

const PI_THINKING_SHORT_LABELS: Record<string, string> = { minimal: 'Min', medium: 'Med' };
export const PI_THINKING: LaunchChoice[] = PI_THINKING_LEVELS
  .filter((level) => level !== 'max')
  .map((level) => ({ value: level, label: PI_THINKING_SHORT_LABELS[level] ?? EFFORT_LABELS[level] ?? level }));

export const ENGINE_ORDER: ReviewEngine[] = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'copilot'];

type MarkerEngine = 'cursor' | 'opencode' | 'pi' | 'copilot';
const MARKER_FALLBACK: Record<MarkerEngine, LaunchChoice[]> = {
  cursor: [{ value: 'auto', label: 'Auto' }],
  opencode: [{ value: '', label: 'Default' }],
  pi: [{ value: '', label: 'Default' }],
  copilot: [{ value: '', label: 'Default' }],
};

export function markerModelChoices(capabilities: AgentCapabilities | null, engine: MarkerEngine): LaunchChoice[] {
  const discovered = (capabilities?.providers.find((p) => p.id === engine)?.models ?? []).map((m) => ({ value: m.id, label: m.label }));
  if (discovered.length === 0) return MARKER_FALLBACK[engine];
  return engine === 'cursor' ? discovered : [...MARKER_FALLBACK[engine], ...discovered];
}

export function markerModelInUse(saved: string, choices: LaunchChoice[]): string {
  return choices.some((c) => c.value === saved) ? saved : (choices[0]?.value ?? saved);
}

export interface LaunchProfile {
  id: string;
  label: string;
  default?: boolean;
}

export interface LaunchSide {
  kind: LaunchKind;
  available: boolean;
  engines: ReviewEngine[];
  engine: ReviewEngine;
  setEngine: (engine: ReviewEngine) => void;
  models: LaunchChoice[] | null;
  model: string;
  setModel: (model: string) => void;
  effortName: string;
  efforts: LaunchChoice[];
  effort: string;
  setEffort: (effort: string) => void;
  fast: { value: boolean; set: (value: boolean) => void } | null;
  notice: string | null;
  catalogEngine: 'claude' | 'codex' | null;
  experimental: boolean;
  ready: boolean;
  summary: string;
  buildParams: (extra?: { instructions?: string }) => AgentLaunchParams;
}

export interface LaunchConfig {
  review: LaunchSide;
  guide: LaunchSide;
  catalogs: ModelCatalogs;
  profiles: LaunchProfile[];
  profileId: string;
  setProfileId: (id: string) => void;
  refreshProfiles: () => void;
  addProfile: (id: string, label: string) => void;
}

const BUILTIN_PROFILE = 'builtin:default';

function effortWord(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

export function launchSummary(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => !!p).join(' · ');
}

export function useLaunchConfig(
  capabilities: AgentCapabilities | null,
  { guideLaunchable = true }: { guideLaunchable?: boolean } = {},
): LaunchConfig {
  const catalogs = useModelCatalogs(capabilities);
  const s = useAgentSettings(catalogs);
  const providerOn = useCallback(
    (id: string) => capabilities?.providers.some((p) => p.id === id && p.available) ?? false,
    [capabilities],
  );
  const engines = useMemo(() => ENGINE_ORDER.filter(providerOn), [providerOn]);
  const pick = (saved: ReviewEngine) => (engines.includes(saved) ? saved : (engines[0] ?? saved));
  const reviewEngine = pick(s.reviewEngine);
  const guideEngine = pick(s.guideEngine);

  const loadCatalog = catalogs.load;
  useEffect(() => loadCatalog(reviewEngine), [loadCatalog, reviewEngine]);
  useEffect(() => loadCatalog(guideEngine), [loadCatalog, guideEngine]);

  const [profiles, setProfiles] = useState<LaunchProfile[]>([{ id: BUILTIN_PROFILE, label: 'Default', default: true }]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const refreshProfiles = useCallback(() => {
    fetch('/api/agents/review-profiles')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.profiles) && d.profiles.length > 0) setProfiles(d.profiles);
      })
      .catch(() => {})
      .finally(() => setProfilesLoaded(true));
  }, []);
  useEffect(() => {
    if (capabilities?.available) refreshProfiles();
  }, [capabilities?.available, refreshProfiles]);
  const addProfile = useCallback((id: string, label: string) => {
    setProfiles((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, label }]));
  }, []);
  const profileId = profiles.some((p) => p.id === s.reviewProfileId) ? s.reviewProfileId : BUILTIN_PROFILE;
  const profileReady = profilesLoaded || s.reviewProfileId === BUILTIN_PROFILE;

  const side = (kind: LaunchKind): LaunchSide => {
    const guide = kind === 'guide';
    const engine = guide ? guideEngine : reviewEngine;
    const engineName = GUIDE_ENGINE_LABEL[engine] ?? engine;
    const setEngine = guide ? s.setGuideEngine : s.setReviewEngine;
    const available = engines.length > 0 && (!guide || (providerOn('guide') && guideLaunchable));
    const base = { kind, available, engines, engine, setEngine };

    if (engine === 'claude' || engine === 'codex') {
      const catalog = catalogs[engine];
      const savedModel = guide
        ? (engine === 'claude' ? s.savedModels.guideClaude : s.savedModels.guideCodex)
        : (engine === 'claude' ? s.savedModels.claude : s.savedModels.codex);
      const model = engine === 'claude' ? (guide ? s.guideClaudeModel : s.claudeModel) : (guide ? s.guideCodexModel : s.codexModel);
      const setModel = engine === 'claude' ? (guide ? s.setGuideClaudeModel : s.setClaudeModel) : (guide ? s.setGuideCodexModel : s.setCodexModel);
      const effort = engine === 'claude' ? (guide ? s.guideClaudeEffort : s.claudeEffort) : (guide ? s.guideCodexReasoning : s.codexReasoning);
      const setEffort = engine === 'claude' ? (guide ? s.setGuideClaudeEffort : s.setClaudeEffort) : (guide ? s.setGuideCodexReasoning : s.setCodexReasoning);
      const efforts = catalog.settled ? effortSelectOptions(catalog.models, model) : [];
      const fastOffered = !guide && engine === 'codex' && catalog.models.find((m) => m.id === model)?.fastMode === true;
      const fastOn = fastOffered && s.codexFast;
      const label = model ? modelLabel(catalog.models, model).replace(/ \(latest\)$/, '') : 'Default';
      const effortField = engine === 'claude' ? 'effort' : 'reasoningEffort';
      return {
        ...base,
        models: catalog.settled ? modelSelectOptions(catalog.models, model) : null,
        model,
        setModel,
        effortName: engine === 'claude' ? 'Effort' : 'Reasoning',
        efforts,
        effort,
        setEffort,
        fast: fastOffered ? { value: s.codexFast, set: s.setCodexFast } : null,
        notice: catalog.settled ? modelFallbackNotice(savedModel, catalog.models, model, engineName) : null,
        catalogEngine: engine,
        experimental: false,
        ready: available && catalog.settled && (guide || profileReady),
        summary: launchSummary([engineName, label, efforts.length > 0 && effort ? effortWord(effort) : null, fastOn && 'Fast']),
        buildParams: (extra) => ({
          provider: guide ? 'guide' : engine,
          label: guide ? 'Guided Review' : 'Code Review',
          ...(guide ? { engine } : {}),
          model,
          ...(efforts.length > 0 || !catalog.settled ? { [effortField]: effort } : {}),
          ...(fastOn ? { fastMode: true } : {}),
          ...(!guide && profileId !== BUILTIN_PROFILE ? { reviewProfileId: profileId } : {}),
          ...(guide && extra?.instructions?.trim() ? { instructions: extra.instructions.trim() } : {}),
        }),
      };
    }

    const marker = engine as MarkerEngine;
    const choices = markerModelChoices(capabilities, marker);
    const savedKey = `${guide ? 'guide' : ''}${guide ? marker.charAt(0).toUpperCase() + marker.slice(1) : marker}` as keyof typeof s.savedModels;
    const saved = s.savedModels[savedKey];
    const model = markerModelInUse(saved, choices);
    const setModel = {
      cursor: guide ? s.setGuideCursorModel : s.setCursorModel,
      opencode: guide ? s.setGuideOpencodeModel : s.setOpencodeModel,
      pi: guide ? s.setGuidePiModel : s.setPiModel,
      copilot: guide ? s.setGuideCopilotModel : s.setCopilotModel,
    }[marker];
    const thinking = guide ? s.guidePiThinking : s.piThinking;
    const setThinking = guide ? s.setGuidePiThinking : s.setPiThinking;
    const discovered = (capabilities?.providers.find((p) => p.id === marker)?.models ?? []).length > 0;
    const label = choices.find((c) => c.value === model)?.label ?? (model || 'Default');
    const sendModel = model && !(marker === 'cursor' && model.toLowerCase() === 'auto');
    return {
      ...base,
      models: choices,
      model,
      setModel,
      effortName: 'Thinking',
      efforts: marker === 'pi' ? PI_THINKING : [],
      effort: marker === 'pi' ? thinking : '',
      setEffort: marker === 'pi' ? setThinking : () => {},
      fast: null,
      notice: discovered
        ? modelFallbackNotice(saved, choices.map((c) => ({ id: c.value, label: c.label })), model, engineName)
        : null,
      catalogEngine: null,
      experimental: true,
      ready: available && (guide || profileReady),
      summary: launchSummary([engineName, label, marker === 'pi' && thinking ? effortWord(thinking) : null]),
      buildParams: (extra) => ({
        provider: guide ? 'guide' : marker,
        label: guide ? 'Guided Review' : 'Code Review',
        ...(guide ? { engine: marker } : {}),
        ...(sendModel ? { model } : {}),
        ...(marker === 'pi' ? { thinking } : {}),
        ...(!guide && profileId !== BUILTIN_PROFILE ? { reviewProfileId: profileId } : {}),
        ...(guide && extra?.instructions?.trim() ? { instructions: extra.instructions.trim() } : {}),
      }),
    };
  };

  return {
    review: side('review'),
    guide: side('guide'),
    catalogs,
    profiles,
    profileId,
    setProfileId: s.setReviewProfileId,
    refreshProfiles,
    addProfile,
  };
}
