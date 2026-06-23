import { useCallback, useEffect, useState } from 'react';
import { getItem, setItem } from '../utils/storage';

const COOKIE_KEY = 'plannotator.agents';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7';
export const DEFAULT_CLAUDE_EFFORT = 'high';
export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';
export const DEFAULT_CODEX_REASONING = 'high';
export const DEFAULT_CODEX_FAST = false;
export const DEFAULT_TOUR_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_TOUR_CLAUDE_EFFORT = 'medium';
export const DEFAULT_TOUR_CODEX_MODEL = 'gpt-5.3-codex';
export const DEFAULT_TOUR_CODEX_REASONING = 'medium';
export const DEFAULT_TOUR_CODEX_FAST = false;
// `auto` is Cursor's own default model id (from `agent models`); lowercase so it
// matches the discovered catalog and the buildCursorCommand omit-`--model` check.
export const DEFAULT_CURSOR_MODEL = 'auto';

interface ClaudeSection {
  model: string;
  perModel: Record<string, { effort: string }>;
}

interface CodexSection {
  model: string;
  perModel: Record<string, { reasoning: string; fast: boolean }>;
}

// Cursor has no per-model sub-settings (no effort/reasoning), so a flat
// { model } section is enough — deliberately simpler than Claude/Codex.
interface CursorSection {
  model: string; // 'Auto' or a discovered/custom model string
}

export type AgentMode = 'review' | 'tour';
export type AgentEngine = 'claude' | 'codex';
// Review-only engine union. Tour stays on the narrow AgentEngine so its
// exhaustive Record<AgentEngine, ...> maps remain valid without change.
export type ReviewEngine = AgentEngine | 'cursor';

interface AgentSettingsState {
  selectedMode?: AgentMode;
  reviewEngine: ReviewEngine;
  tourEngine: AgentEngine;
  claude: ClaudeSection;
  codex: CodexSection;
  cursor: CursorSection;
  tourClaude: ClaudeSection;
  tourCodex: CodexSection;
}

const initialState: AgentSettingsState = {
  selectedMode: 'review',
  reviewEngine: 'claude',
  tourEngine: 'claude',
  claude: { model: DEFAULT_CLAUDE_MODEL, perModel: {} },
  codex: { model: DEFAULT_CODEX_MODEL, perModel: {} },
  cursor: { model: DEFAULT_CURSOR_MODEL },
  tourClaude: { model: DEFAULT_TOUR_CLAUDE_MODEL, perModel: {} },
  tourCodex: { model: DEFAULT_TOUR_CODEX_MODEL, perModel: {} },
};

// One-shot migration: drop any cached "none" codex reasoning entries. The
// dropdown no longer offers "None" (codex-rs rejects it as a config value);
// fall back to the default instead of shipping an invalid flag.
export function sanitizeCodexPerModel(
  perModel: Record<string, { reasoning: string; fast: boolean }> | undefined,
): Record<string, { reasoning: string; fast: boolean }> {
  if (!perModel) return {};
  const out: Record<string, { reasoning: string; fast: boolean }> = {};
  for (const [model, entry] of Object.entries(perModel)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.reasoning === 'none') {
      if (entry.fast) out[model] = { reasoning: DEFAULT_CODEX_REASONING, fast: true };
      continue;
    }
    out[model] = entry;
  }
  return out;
}

function parseEngine(value: unknown): AgentEngine {
  return value === 'codex' ? 'codex' : 'claude';
}

function parseReviewEngine(value: unknown): ReviewEngine {
  if (value === 'cursor') return 'cursor';
  return parseEngine(value);
}

function parseMode(value: unknown): AgentMode | undefined {
  if (value === 'review' || value === 'tour') return value;
  return undefined;
}

function readCookie(): AgentSettingsState {
  const raw = getItem(COOKIE_KEY);
  if (!raw) return initialState;
  try {
    const parsed = JSON.parse(raw);
    return {
      selectedMode: parseMode(parsed.selectedMode) ?? initialState.selectedMode,
      reviewEngine: parseReviewEngine(parsed.reviewEngine),
      tourEngine: parseEngine(parsed.tourEngine),
      claude: {
        model: typeof parsed.claude?.model === 'string' ? parsed.claude.model : DEFAULT_CLAUDE_MODEL,
        perModel: parsed.claude?.perModel ?? {},
      },
      codex: {
        model: typeof parsed.codex?.model === 'string' ? parsed.codex.model : DEFAULT_CODEX_MODEL,
        perModel: sanitizeCodexPerModel(parsed.codex?.perModel),
      },
      cursor: {
        model: typeof parsed.cursor?.model === 'string' ? parsed.cursor.model : DEFAULT_CURSOR_MODEL,
      },
      tourClaude: {
        model: typeof parsed.tourClaude?.model === 'string' ? parsed.tourClaude.model : DEFAULT_TOUR_CLAUDE_MODEL,
        perModel: parsed.tourClaude?.perModel ?? {},
      },
      tourCodex: {
        model: typeof parsed.tourCodex?.model === 'string' ? parsed.tourCodex.model : DEFAULT_TOUR_CODEX_MODEL,
        perModel: sanitizeCodexPerModel(parsed.tourCodex?.perModel),
      },
    };
  } catch {
    return initialState;
  }
}

export function useAgentSettings() {
  const [state, setState] = useState<AgentSettingsState>(readCookie);

  useEffect(() => {
    setItem(COOKIE_KEY, JSON.stringify(state));
  }, [state]);

  const setSelectedMode = useCallback((mode: AgentMode) => {
    setState((s) => ({ ...s, selectedMode: mode }));
  }, []);

  const setReviewEngine = useCallback((engine: ReviewEngine) => {
    setState((s) => ({ ...s, reviewEngine: engine }));
  }, []);

  const setTourEngine = useCallback((engine: AgentEngine) => {
    setState((s) => ({ ...s, tourEngine: engine }));
  }, []);

  const setClaudeModel = useCallback((model: string) => {
    setState((s) => ({ ...s, claude: { ...s.claude, model } }));
  }, []);

  const patchClaude = useCallback(
    (section: 'claude' | 'tourClaude', patch: Partial<{ effort: string }>) => {
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

  const patchCodex = useCallback(
    (
      section: 'codex' | 'tourCodex',
      patch: Partial<{ reasoning: string; fast: boolean }>,
      defaults: { reasoning: string; fast: boolean },
    ) => {
      setState((s) => {
        const cur = s[section];
        const prev = cur.perModel[cur.model] ?? defaults;
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

  const setCodexReasoning = useCallback(
    (reasoning: string) => patchCodex('codex', { reasoning }, { reasoning: DEFAULT_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }),
    [patchCodex],
  );
  const setCodexFast = useCallback(
    (fast: boolean) => patchCodex('codex', { fast }, { reasoning: DEFAULT_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }),
    [patchCodex],
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
    (reasoning: string) => patchCodex('tourCodex', { reasoning }, { reasoning: DEFAULT_TOUR_CODEX_REASONING, fast: DEFAULT_TOUR_CODEX_FAST }),
    [patchCodex],
  );
  const setTourCodexFast = useCallback(
    (fast: boolean) => patchCodex('tourCodex', { fast }, { reasoning: DEFAULT_TOUR_CODEX_REASONING, fast: DEFAULT_TOUR_CODEX_FAST }),
    [patchCodex],
  );

  const claudeEffort = state.claude.perModel[state.claude.model]?.effort ?? DEFAULT_CLAUDE_EFFORT;
  const codexReasoning = state.codex.perModel[state.codex.model]?.reasoning ?? DEFAULT_CODEX_REASONING;
  const codexFast = state.codex.perModel[state.codex.model]?.fast ?? DEFAULT_CODEX_FAST;
  const tourClaudeEffort = state.tourClaude.perModel[state.tourClaude.model]?.effort ?? DEFAULT_TOUR_CLAUDE_EFFORT;
  const tourCodexReasoning = state.tourCodex.perModel[state.tourCodex.model]?.reasoning ?? DEFAULT_TOUR_CODEX_REASONING;
  const tourCodexFast = state.tourCodex.perModel[state.tourCodex.model]?.fast ?? DEFAULT_TOUR_CODEX_FAST;

  return {
    selectedMode: state.selectedMode,
    reviewEngine: state.reviewEngine,
    tourEngine: state.tourEngine,
    claudeModel: state.claude.model,
    claudeEffort,
    codexModel: state.codex.model,
    codexReasoning,
    codexFast,
    cursorModel: state.cursor.model,
    tourClaudeModel: state.tourClaude.model,
    tourClaudeEffort,
    tourCodexModel: state.tourCodex.model,
    tourCodexReasoning,
    tourCodexFast,
    setSelectedMode,
    setReviewEngine,
    setTourEngine,
    setClaudeModel,
    setClaudeEffort,
    setCodexModel,
    setCodexReasoning,
    setCodexFast,
    setCursorModel,
    setTourClaudeModel,
    setTourClaudeEffort,
    setTourCodexModel,
    setTourCodexReasoning,
    setTourCodexFast,
  };
}
