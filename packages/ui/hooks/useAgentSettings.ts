import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveEffortChoice, resolveModelChoice } from '@plannotator/core/model-catalog';
import { getItem, setItem } from '../utils/storage';
import type { ModelCatalog, ModelCatalogs } from './useModelCatalogs';

const COOKIE_KEY = 'plannotator.agents';

const settingsListeners = new Set<(s: AgentSettingsState) => void>();

export const DEFAULT_CLAUDE_MODEL = 'opus';
export const DEFAULT_CLAUDE_EFFORT = 'high';
export const DEFAULT_CODEX_MODEL = '';
export const DEFAULT_CODEX_REASONING = 'high';
export const DEFAULT_CODEX_FAST = false;
export const DEFAULT_TOUR_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_TOUR_CLAUDE_EFFORT = 'medium';
export const DEFAULT_TOUR_CODEX_MODEL = '';
export const DEFAULT_TOUR_CODEX_REASONING = 'medium';
export const DEFAULT_TOUR_CODEX_FAST = false;
export const DEFAULT_GUIDE_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_GUIDE_CLAUDE_EFFORT = 'low';
export const DEFAULT_GUIDE_CODEX_MODEL = '';
export const PREFERRED_GUIDE_CODEX_MODEL = 'gpt-6-luna';
export const DEFAULT_GUIDE_CODEX_REASONING = 'low';
export const DEFAULT_CURSOR_MODEL = 'auto';

export const DEFAULT_OPENCODE_MODEL = '';

export const DEFAULT_PI_MODEL = '';
export const DEFAULT_PI_THINKING = 'medium';

export const DEFAULT_COPILOT_MODEL = '';

export const DEFAULT_GUIDE_CURSOR_MODEL = 'auto';
export const DEFAULT_GUIDE_OPENCODE_MODEL = '';
export const DEFAULT_GUIDE_PI_MODEL = '';
export const DEFAULT_GUIDE_PI_THINKING = 'medium';
export const DEFAULT_GUIDE_COPILOT_MODEL = '';

interface ClaudeSection {
  model: string;
  perModel: Record<string, { effort: string }>;
}

interface CodexSection {
  model: string;
  perModel: Record<string, { reasoning: string; fast: boolean }>;
}

interface CursorSection {
  model: string;
}

interface OpencodeSection {
  model: string;
}

interface PiSection {
  model: string;
  thinking: string;
}

interface CopilotSection {
  model: string;
}

export type AgentMode = 'review' | 'tour' | 'guide';
export type AgentEngine = 'claude' | 'codex';
export type ReviewEngine = AgentEngine | 'cursor' | 'opencode' | 'pi' | 'copilot';

interface AgentSettingsState {
  selectedMode?: AgentMode;
  reviewEngine: ReviewEngine;
  reviewProfileByEngine: Record<ReviewEngine, string>;
  tourEngine: AgentEngine;
  guideEngine: ReviewEngine;
  claude: ClaudeSection;
  codex: CodexSection;
  cursor: CursorSection;
  opencode: OpencodeSection;
  pi: PiSection;
  copilot: CopilotSection;
  tourClaude: ClaudeSection;
  tourCodex: CodexSection;
  guideClaude: ClaudeSection;
  guideCodex: CodexSection;
  guideCursor: CursorSection;
  guideOpencode: OpencodeSection;
  guidePi: PiSection;
  guideCopilot: CopilotSection;
}

const BUILTIN_DEFAULT_PROFILE = 'builtin:default';
const REVIEW_ENGINES: ReviewEngine[] = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'copilot'];

const initialState: AgentSettingsState = {
  selectedMode: 'review',
  reviewEngine: 'claude',
  reviewProfileByEngine: {
    claude: BUILTIN_DEFAULT_PROFILE,
    codex: BUILTIN_DEFAULT_PROFILE,
    cursor: BUILTIN_DEFAULT_PROFILE,
    opencode: BUILTIN_DEFAULT_PROFILE,
    pi: BUILTIN_DEFAULT_PROFILE,
    copilot: BUILTIN_DEFAULT_PROFILE,
  },
  tourEngine: 'claude',
  guideEngine: 'claude',
  claude: { model: DEFAULT_CLAUDE_MODEL, perModel: {} },
  codex: { model: DEFAULT_CODEX_MODEL, perModel: {} },
  cursor: { model: DEFAULT_CURSOR_MODEL },
  opencode: { model: DEFAULT_OPENCODE_MODEL },
  pi: { model: DEFAULT_PI_MODEL, thinking: DEFAULT_PI_THINKING },
  copilot: { model: DEFAULT_COPILOT_MODEL },
  tourClaude: { model: DEFAULT_TOUR_CLAUDE_MODEL, perModel: {} },
  tourCodex: { model: DEFAULT_TOUR_CODEX_MODEL, perModel: {} },
  guideClaude: { model: DEFAULT_GUIDE_CLAUDE_MODEL, perModel: {} },
  guideCodex: { model: DEFAULT_GUIDE_CODEX_MODEL, perModel: {} },
  guideCursor: { model: DEFAULT_GUIDE_CURSOR_MODEL },
  guideOpencode: { model: DEFAULT_GUIDE_OPENCODE_MODEL },
  guidePi: { model: DEFAULT_GUIDE_PI_MODEL, thinking: DEFAULT_GUIDE_PI_THINKING },
  guideCopilot: { model: DEFAULT_GUIDE_COPILOT_MODEL },
};

function parseModelSection<P>(
  section: { model?: unknown; perModel?: unknown } | undefined,
  fallback: string,
): { model: string; perModel: Record<string, P> } {
  return {
    model: typeof section?.model === 'string' ? section.model : fallback,
    perModel: (section?.perModel as Record<string, P> | undefined) ?? {},
  };
}

function parseEngine(value: unknown): AgentEngine {
  return value === 'codex' ? 'codex' : 'claude';
}

function parseReviewEngine(value: unknown): ReviewEngine {
  if (value === 'cursor') return 'cursor';
  if (value === 'opencode') return 'opencode';
  if (value === 'pi') return 'pi';
  if (value === 'copilot') return 'copilot';
  return parseEngine(value);
}

function parseMode(value: unknown): AgentMode | undefined {
  if (value === 'review' || value === 'tour' || value === 'guide') return value;
  return undefined;
}

export function parseReviewProfileByEngine(parsed: {
  reviewProfileByEngine?: unknown;
  reviewProfileId?: unknown;
}): Record<ReviewEngine, string> {
  const byEngine = parsed.reviewProfileByEngine as Record<string, unknown> | undefined;
  const legacy = typeof parsed.reviewProfileId === 'string' ? parsed.reviewProfileId : BUILTIN_DEFAULT_PROFILE;
  const out = {} as Record<ReviewEngine, string>;
  for (const engine of REVIEW_ENGINES) {
    out[engine] = typeof byEngine?.[engine] === 'string' ? (byEngine[engine] as string) : legacy;
  }
  return out;
}

function readCookie(): AgentSettingsState {
  const raw = getItem(COOKIE_KEY);
  if (!raw) return initialState;
  try {
    const parsed = JSON.parse(raw);
    return {
      selectedMode: parseMode(parsed.selectedMode) ?? initialState.selectedMode,
      reviewEngine: parseReviewEngine(parsed.reviewEngine),
      reviewProfileByEngine: parseReviewProfileByEngine(parsed),
      tourEngine: parseEngine(parsed.tourEngine),
      guideEngine: parseReviewEngine(parsed.guideEngine),
      claude: parseModelSection(parsed.claude, DEFAULT_CLAUDE_MODEL),
      codex: parseModelSection(parsed.codex, DEFAULT_CODEX_MODEL),
      cursor: {
        model: typeof parsed.cursor?.model === 'string' ? parsed.cursor.model : DEFAULT_CURSOR_MODEL,
      },
      opencode: {
        model: typeof parsed.opencode?.model === 'string' ? parsed.opencode.model : DEFAULT_OPENCODE_MODEL,
      },
      pi: {
        model: typeof parsed.pi?.model === 'string' ? parsed.pi.model : DEFAULT_PI_MODEL,
        thinking: typeof parsed.pi?.thinking === 'string' ? parsed.pi.thinking : DEFAULT_PI_THINKING,
      },
      copilot: {
        model: typeof parsed.copilot?.model === 'string' ? parsed.copilot.model : DEFAULT_COPILOT_MODEL,
      },
      tourClaude: parseModelSection(parsed.tourClaude, DEFAULT_TOUR_CLAUDE_MODEL),
      tourCodex: parseModelSection(parsed.tourCodex, DEFAULT_TOUR_CODEX_MODEL),
      guideClaude: parseModelSection(parsed.guideClaude, DEFAULT_GUIDE_CLAUDE_MODEL),
      guideCodex: parseModelSection(parsed.guideCodex, DEFAULT_GUIDE_CODEX_MODEL),
      guideCursor: {
        model: typeof parsed.guideCursor?.model === 'string' ? parsed.guideCursor.model : DEFAULT_GUIDE_CURSOR_MODEL,
      },
      guideOpencode: {
        model: typeof parsed.guideOpencode?.model === 'string' ? parsed.guideOpencode.model : DEFAULT_GUIDE_OPENCODE_MODEL,
      },
      guidePi: {
        model: typeof parsed.guidePi?.model === 'string' ? parsed.guidePi.model : DEFAULT_GUIDE_PI_MODEL,
        thinking: typeof parsed.guidePi?.thinking === 'string' ? parsed.guidePi.thinking : DEFAULT_GUIDE_PI_THINKING,
      },
      guideCopilot: {
        model: typeof parsed.guideCopilot?.model === 'string' ? parsed.guideCopilot.model : DEFAULT_GUIDE_COPILOT_MODEL,
      },
    };
  } catch {
    return initialState;
  }
}

export function effectiveModel(catalog: ModelCatalog | undefined, saved: string, surfaceDefault: string): string {
  return catalog?.settled ? resolveModelChoice(saved, catalog.models, surfaceDefault) : saved;
}

export function effectiveEffort(catalog: ModelCatalog | undefined, model: string, effort: string): string {
  return catalog?.settled ? resolveEffortChoice(effort, catalog.models, model) : effort;
}

export function effectiveFast(catalog: ModelCatalog | undefined, savedModel: string, model: string, fast: boolean): boolean {
  if (!fast || !catalog?.settled) return fast;
  if (savedModel && savedModel !== model) return false;
  const entry = catalog.models.find((m) => m.id === model);
  return entry ? entry.fastMode === true : fast;
}

export function useAgentSettings(catalogs?: ModelCatalogs) {
  const [state, setState] = useState<AgentSettingsState>(readCookie);
  const lastSyncedJsonRef = useRef<string | null>(null);
  const ownListenerRef = useRef<((s: AgentSettingsState) => void) | null>(null);

  useEffect(() => {
    const listener = (next: AgentSettingsState) => {
      lastSyncedJsonRef.current = JSON.stringify(next);
      setState(next);
    };
    ownListenerRef.current = listener;
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
      ownListenerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const json = JSON.stringify(state);
    if (json === lastSyncedJsonRef.current) return;
    lastSyncedJsonRef.current = json;
    setItem(COOKIE_KEY, json);
    for (const listener of settingsListeners) {
      if (listener !== ownListenerRef.current) listener(state);
    }
  }, [state]);

  const setSelectedMode = useCallback((mode: AgentMode) => {
    setState((s) => ({ ...s, selectedMode: mode }));
  }, []);

  const setReviewEngine = useCallback((engine: ReviewEngine) => {
    setState((s) => ({ ...s, reviewEngine: engine }));
  }, []);

  const setReviewProfileId = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      reviewProfileByEngine: { ...s.reviewProfileByEngine, [s.reviewEngine]: id },
    }));
  }, []);

  const setTourEngine = useCallback((engine: AgentEngine) => {
    setState((s) => ({ ...s, tourEngine: engine }));
  }, []);

  const setGuideEngine = useCallback((engine: ReviewEngine) => {
    setState((s) => ({ ...s, guideEngine: engine }));
  }, []);

  const setClaudeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, claude: { ...s.claude, model } }));
  }, []);

  const patchClaude = useCallback(
    (section: 'claude' | 'tourClaude' | 'guideClaude', patch: Partial<{ effort: string }>) => {
      setState((s) => {
        const cur = s[section];
        const prev = cur.perModel[cur.model] ?? { effort: '' };
        return {
          ...s,
          [section]: {
            ...cur,
            perModel: { ...cur.perModel, [cur.model]: { ...prev, ...patch } },
          },
        };
      });
    },
    [],
  );

  const setClaudeEffort = useCallback(
    (effort: string) => patchClaude('claude', { effort }),
    [patchClaude],
  );

  const setCodexModel = useCallback((model: string) => {
    setState((s) => ({ ...s, codex: { ...s.codex, model } }));
  }, []);

  const setCursorModel = useCallback((model: string) => {
    setState((s) => ({ ...s, cursor: { ...s.cursor, model } }));
  }, []);

  const setOpencodeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, opencode: { ...s.opencode, model } }));
  }, []);

  const setPiModel = useCallback((model: string) => {
    setState((s) => ({ ...s, pi: { ...s.pi, model } }));
  }, []);

  const setPiThinking = useCallback((thinking: string) => {
    setState((s) => ({ ...s, pi: { ...s.pi, thinking } }));
  }, []);

  const setCopilotModel = useCallback((model: string) => {
    setState((s) => ({ ...s, copilot: { ...s.copilot, model } }));
  }, []);

  const patchCodex = useCallback(
    (
      section: 'codex' | 'tourCodex' | 'guideCodex',
      patch: Partial<{ reasoning: string; fast: boolean }>,
      defaults: { reasoning: string; fast: boolean },
      shown: { model: string; reasoning: string; fast: boolean },
    ) => {
      setState((s) => {
        const cur = s[section];
        const replaced = !!cur.model && !!shown.model && shown.model !== cur.model;
        const model = replaced ? shown.model : cur.model;
        const prev =
          cur.perModel[model] ?? (replaced ? { reasoning: shown.reasoning, fast: shown.fast } : defaults);
        return {
          ...s,
          [section]: {
            ...cur,
            model,
            perModel: { ...cur.perModel, [model]: { ...prev, ...patch } },
          },
        };
      });
    },
    [],
  );

  const claudeCatalog = catalogs?.claude;
  const codexCatalog = catalogs?.codex;
  const claudeModel = effectiveModel(claudeCatalog, state.claude.model, DEFAULT_CLAUDE_MODEL);
  const claudeEffort = effectiveEffort(claudeCatalog, claudeModel, state.claude.perModel[state.claude.model]?.effort ?? DEFAULT_CLAUDE_EFFORT);
  const codexModel = effectiveModel(codexCatalog, state.codex.model, DEFAULT_CODEX_MODEL);
  const codexReasoning = effectiveEffort(codexCatalog, codexModel, state.codex.perModel[state.codex.model]?.reasoning ?? DEFAULT_CODEX_REASONING);
  const codexFast = effectiveFast(codexCatalog, state.codex.model, codexModel, state.codex.perModel[state.codex.model]?.fast ?? DEFAULT_CODEX_FAST);
  const tourClaudeModel = effectiveModel(claudeCatalog, state.tourClaude.model, DEFAULT_TOUR_CLAUDE_MODEL);
  const tourClaudeEffort = effectiveEffort(claudeCatalog, tourClaudeModel, state.tourClaude.perModel[state.tourClaude.model]?.effort ?? DEFAULT_TOUR_CLAUDE_EFFORT);
  const tourCodexModel = effectiveModel(codexCatalog, state.tourCodex.model, DEFAULT_TOUR_CODEX_MODEL);
  const tourCodexReasoning = effectiveEffort(codexCatalog, tourCodexModel, state.tourCodex.perModel[state.tourCodex.model]?.reasoning ?? DEFAULT_TOUR_CODEX_REASONING);
  const tourCodexFast = effectiveFast(codexCatalog, state.tourCodex.model, tourCodexModel, state.tourCodex.perModel[state.tourCodex.model]?.fast ?? DEFAULT_TOUR_CODEX_FAST);
  const guideClaudeModel = effectiveModel(claudeCatalog, state.guideClaude.model, DEFAULT_GUIDE_CLAUDE_MODEL);
  const guideClaudeEffort = effectiveEffort(claudeCatalog, guideClaudeModel, state.guideClaude.perModel[state.guideClaude.model]?.effort ?? DEFAULT_GUIDE_CLAUDE_EFFORT);
  const guideCodexModel = effectiveModel(codexCatalog, state.guideCodex.model, PREFERRED_GUIDE_CODEX_MODEL);
  const guideCodexReasoning = effectiveEffort(codexCatalog, guideCodexModel, state.guideCodex.perModel[state.guideCodex.model]?.reasoning ?? DEFAULT_GUIDE_CODEX_REASONING);
  const guideCodexFast = state.guideCodex.perModel[state.guideCodex.model]?.fast ?? DEFAULT_CODEX_FAST;

  const setCodexReasoning = useCallback(
    (reasoning: string) =>
      patchCodex('codex', { reasoning }, { reasoning: DEFAULT_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }, { model: codexModel, reasoning: codexReasoning, fast: codexFast }),
    [patchCodex, codexModel, codexReasoning, codexFast],
  );
  const setCodexFast = useCallback(
    (fast: boolean) =>
      patchCodex('codex', { fast }, { reasoning: DEFAULT_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }, { model: codexModel, reasoning: codexReasoning, fast: codexFast }),
    [patchCodex, codexModel, codexReasoning, codexFast],
  );

  const setTourClaudeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, tourClaude: { ...s.tourClaude, model } }));
  }, []);

  const setTourClaudeEffort = useCallback(
    (effort: string) => patchClaude('tourClaude', { effort }),
    [patchClaude],
  );

  const setTourCodexModel = useCallback((model: string) => {
    setState((s) => ({ ...s, tourCodex: { ...s.tourCodex, model } }));
  }, []);

  const setTourCodexReasoning = useCallback(
    (reasoning: string) =>
      patchCodex('tourCodex', { reasoning }, { reasoning: DEFAULT_TOUR_CODEX_REASONING, fast: DEFAULT_TOUR_CODEX_FAST }, { model: tourCodexModel, reasoning: tourCodexReasoning, fast: tourCodexFast }),
    [patchCodex, tourCodexModel, tourCodexReasoning, tourCodexFast],
  );
  const setTourCodexFast = useCallback(
    (fast: boolean) =>
      patchCodex('tourCodex', { fast }, { reasoning: DEFAULT_TOUR_CODEX_REASONING, fast: DEFAULT_TOUR_CODEX_FAST }, { model: tourCodexModel, reasoning: tourCodexReasoning, fast: tourCodexFast }),
    [patchCodex, tourCodexModel, tourCodexReasoning, tourCodexFast],
  );

  const setGuideClaudeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guideClaude: { ...s.guideClaude, model } }));
  }, []);

  const setGuideClaudeEffort = useCallback(
    (effort: string) => patchClaude('guideClaude', { effort }),
    [patchClaude],
  );

  const setGuideCodexModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guideCodex: { ...s.guideCodex, model } }));
  }, []);

  const setGuideCodexReasoning = useCallback(
    (reasoning: string) =>
      patchCodex('guideCodex', { reasoning }, { reasoning: DEFAULT_GUIDE_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }, { model: guideCodexModel, reasoning: guideCodexReasoning, fast: guideCodexFast }),
    [patchCodex, guideCodexModel, guideCodexReasoning, guideCodexFast],
  );

  const setGuideCursorModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guideCursor: { ...s.guideCursor, model } }));
  }, []);

  const setGuideOpencodeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guideOpencode: { ...s.guideOpencode, model } }));
  }, []);

  const setGuidePiModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guidePi: { ...s.guidePi, model } }));
  }, []);

  const setGuidePiThinking = useCallback((thinking: string) => {
    setState((s) => ({ ...s, guidePi: { ...s.guidePi, thinking } }));
  }, []);

  const setGuideCopilotModel = useCallback((model: string) => {
    setState((s) => ({ ...s, guideCopilot: { ...s.guideCopilot, model } }));
  }, []);

  return {
    selectedMode: state.selectedMode,
    reviewEngine: state.reviewEngine,
    reviewProfileId: state.reviewProfileByEngine[state.reviewEngine] ?? BUILTIN_DEFAULT_PROFILE,
    tourEngine: state.tourEngine,
    guideEngine: state.guideEngine,
    claudeModel,
    claudeEffort,
    codexModel,
    codexReasoning,
    codexFast,
    cursorModel: state.cursor.model,
    opencodeModel: state.opencode.model,
    piModel: state.pi.model,
    piThinking: state.pi.thinking,
    copilotModel: state.copilot.model,
    tourClaudeModel,
    tourClaudeEffort,
    tourCodexModel,
    tourCodexReasoning,
    tourCodexFast,
    guideClaudeModel,
    guideClaudeEffort,
    guideCodexModel,
    guideCodexReasoning,
    guideCursorModel: state.guideCursor.model,
    guideOpencodeModel: state.guideOpencode.model,
    guidePiModel: state.guidePi.model,
    guidePiThinking: state.guidePi.thinking,
    guideCopilotModel: state.guideCopilot.model,
    setSelectedMode,
    setReviewEngine,
    setReviewProfileId,
    setTourEngine,
    setGuideEngine,
    setClaudeModel,
    setClaudeEffort,
    setCodexModel,
    setCodexReasoning,
    setCodexFast,
    setCursorModel,
    setOpencodeModel,
    setPiModel,
    setPiThinking,
    setCopilotModel,
    setTourClaudeModel,
    setTourClaudeEffort,
    setTourCodexModel,
    setTourCodexReasoning,
    setTourCodexFast,
    setGuideClaudeModel,
    setGuideClaudeEffort,
    setGuideCodexModel,
    setGuideCodexReasoning,
    setGuideCursorModel,
    setGuideOpencodeModel,
    setGuidePiModel,
    setGuidePiThinking,
    setGuideCopilotModel,
  };
}
