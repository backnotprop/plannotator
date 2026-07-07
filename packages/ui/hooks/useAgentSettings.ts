import { useCallback, useEffect, useRef, useState } from 'react';
import { getItem, setItem } from '../utils/storage';

const COOKIE_KEY = 'plannotator.agents';

// Multiple live instances of this hook can be mounted at once (e.g. the
// Settings AgentsTab and the Guided Review empty-state launch panel are both
// mounted simultaneously). Each instance held fully independent state and
// wrote the WHOLE cookie blob on every change, so the last writer clobbered
// any change the other instance made in the meantime (e.g. picking a guide
// model in one tab silently reverted a review-engine pick made in the other).
// `settingsListeners` lets every write broadcast its resulting state to every
// OTHER mounted instance so they stay in sync without a shared store. Listeners
// must ONLY call setState — never re-write the cookie — or a broadcast loop
// would clobber writes exactly like before.
const settingsListeners = new Set<(s: AgentSettingsState) => void>();

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7';
export const DEFAULT_CLAUDE_EFFORT = 'high';
// gpt-5.3-codex is deprecated (ChatGPT-account Codex rejects it outright) —
// default to the current flagship everywhere.
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_REASONING = 'high';
export const DEFAULT_CODEX_FAST = false;
export const DEFAULT_TOUR_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_TOUR_CLAUDE_EFFORT = 'medium';
export const DEFAULT_TOUR_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_TOUR_CODEX_REASONING = 'medium';
export const DEFAULT_TOUR_CODEX_FAST = false;
export const DEFAULT_GUIDE_CLAUDE_MODEL = 'sonnet';
// Guide defaults run LOWER effort than tour/review on purpose: a guide is an
// orientation doc the reviewer is actively waiting on, and newer models at
// low effort chapter a diff well. Guide-scoped only — tour/review keep medium.
export const DEFAULT_GUIDE_CLAUDE_EFFORT = 'low';
export const DEFAULT_GUIDE_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_GUIDE_CODEX_REASONING = 'low';
// No DEFAULT_GUIDE_CODEX_FAST: fast mode is deliberately not offered for
// guide (product decision — see AgentsTab's guide codex config block), so
// there is no getter/setter to default. patchCodex below still needs SOME
// `fast` default to satisfy CodexSection's per-model shape when it seeds a
// new model entry; DEFAULT_CODEX_FAST (false, same value) covers that without
// implying a guide-specific fast toggle exists.
// `auto` is Cursor's own default model id (from `agent models`); lowercase so it
// matches the discovered catalog and the buildCursorCommand omit-`--model` check.
export const DEFAULT_CURSOR_MODEL = 'auto';

// OpenCode has no `auto` pseudo-model; empty string means "use OpenCode's
// configured default" and buildOpencodeCommand omits `--model` for it.
export const DEFAULT_OPENCODE_MODEL = '';

// Pi has no `auto` pseudo-model either; empty string means "use Pi's own
// default" and buildArgv omits `--model` for it — same convention as OpenCode.
export const DEFAULT_PI_MODEL = '';
// Pi's unified reasoning knob (`--thinking`); 'medium' matches Pi's own default.
export const DEFAULT_PI_THINKING = 'medium';

// Copilot has no `auto` pseudo-model in our picker; empty string means "let
// Copilot pick" and copilotBuildArgv omits `--model` for it — same convention
// as OpenCode/Pi.
export const DEFAULT_COPILOT_MODEL = '';

// Guide-scoped marker-engine defaults — same isolation rationale as
// DEFAULT_GUIDE_CLAUDE_EFFORT above (a guide's Cursor/OpenCode/Pi model must
// not silently change the next Cursor/OpenCode/Pi code review, and vice
// versa). These literal values happen to match the shared defaults above —
// they are NOT derived/seeded from them, just each engine's own natural
// default picked independently for the guide surface.
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

// Cursor/OpenCode have no per-model sub-settings (no effort/reasoning), so a
// flat { model } section is enough — deliberately simpler than Claude/Codex.
interface CursorSection {
  model: string; // 'auto' or a discovered model id
}

interface OpencodeSection {
  model: string; // '' (default) or a discovered provider/model id
}

// Pi: flat model plus its single global reasoning knob (`--thinking`), which
// applies to whatever model is selected — unlike Claude/Codex there is no
// per-model effort map.
interface PiSection {
  model: string; // '' (default) or a discovered model id
  thinking: string; // off | minimal | low | medium | high | xhigh
}

// Copilot: flat model only, like Cursor/OpenCode (its --effort knob is
// deliberately not surfaced yet — the CLI default is sensible).
interface CopilotSection {
  model: string; // '' (default) or a model id from `copilot help config`
}

export type AgentMode = 'review' | 'tour' | 'guide';
export type AgentEngine = 'claude' | 'codex';
// Review-only engine union. Tour stays on the narrow AgentEngine so its
// exhaustive Record<AgentEngine, ...> maps remain valid without change.
export type ReviewEngine = AgentEngine | 'cursor' | 'opencode' | 'pi' | 'copilot';

interface AgentSettingsState {
  selectedMode?: AgentMode;
  reviewEngine: ReviewEngine;
  // Selected review profile is tracked per review engine so each agent can have
  // its own default (e.g. Claude runs one review, Cursor another) — mirrors how
  // `model` is per-engine. The current value is reviewProfileByEngine[reviewEngine].
  reviewProfileByEngine: Record<ReviewEngine, string>;
  tourEngine: AgentEngine;
  // Guide runs on the wide union: marker engines (cursor/opencode) generate
  // guides via the marker-block JSON contract, same as marker review jobs.
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
  // Guide-scoped marker-engine settings — kept separate from cursor/opencode/pi
  // above (same isolation as guideClaude/guideCodex vs claude/codex) so tuning
  // a guide's Cursor/OpenCode/Pi model doesn't silently change the next
  // Cursor/OpenCode/Pi code review.
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

// One-shot migration: gpt-5.3-codex is deprecated (ChatGPT-account Codex
// rejects it with a 400), so a saved pick of it silently becomes the current
// default rather than shipping a launch that can never succeed.
function migrateCodexModel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === 'gpt-5.3-codex') return fallback;
  return value;
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

// Parse the per-engine review map, migrating the old flat global `reviewProfileId`:
// seed every engine with it so an existing pick isn't lost; engines diverge from there.
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
      claude: {
        model: typeof parsed.claude?.model === 'string' ? parsed.claude.model : DEFAULT_CLAUDE_MODEL,
        perModel: parsed.claude?.perModel ?? {},
      },
      codex: {
        model: migrateCodexModel(parsed.codex?.model, DEFAULT_CODEX_MODEL),
        perModel: sanitizeCodexPerModel(parsed.codex?.perModel),
      },
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
      tourClaude: {
        model: typeof parsed.tourClaude?.model === 'string' ? parsed.tourClaude.model : DEFAULT_TOUR_CLAUDE_MODEL,
        perModel: parsed.tourClaude?.perModel ?? {},
      },
      tourCodex: {
        model: migrateCodexModel(parsed.tourCodex?.model, DEFAULT_TOUR_CODEX_MODEL),
        perModel: sanitizeCodexPerModel(parsed.tourCodex?.perModel),
      },
      guideClaude: {
        model: typeof parsed.guideClaude?.model === 'string' ? parsed.guideClaude.model : DEFAULT_GUIDE_CLAUDE_MODEL,
        perModel: parsed.guideClaude?.perModel ?? {},
      },
      guideCodex: {
        model: migrateCodexModel(parsed.guideCodex?.model, DEFAULT_GUIDE_CODEX_MODEL),
        perModel: sanitizeCodexPerModel(parsed.guideCodex?.perModel),
      },
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

export function useAgentSettings() {
  const [state, setState] = useState<AgentSettingsState>(readCookie);
  // Serialized form of the state this instance knows is already persisted
  // and broadcast. The persist effect compares VALUES against this instead
  // of using a "was the last update remote?" boolean: a boolean conflates
  // "a commit happened" with "the LAST change was remote", so a local edit
  // landing in the same commit window as an incoming broadcast (fast input
  // between paint and effects, or a setter batched with the remote apply)
  // would consume the flag and silently skip its own cookie write and
  // rebroadcast. Value comparison is idempotent: a pure remote apply
  // serializes identically and skips; ANY local delta differs and persists.
  const lastSyncedJsonRef = useRef<string | null>(null);
  // This instance's own listener function, so the broadcast loop below can
  // skip notifying itself.
  const ownListenerRef = useRef<((s: AgentSettingsState) => void) | null>(null);

  // Register to receive broadcasts from other mounted instances (e.g. the
  // Settings AgentsTab and the Guided Review empty-state launch panel are
  // both mounted at once, each with independent state — without this, the
  // last writer's cookie write would clobber the other's in-flight change).
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

  // Writes the review for the CURRENTLY selected engine, so each engine keeps its own.
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
    (reasoning: string) => patchCodex('guideCodex', { reasoning }, { reasoning: DEFAULT_GUIDE_CODEX_REASONING, fast: DEFAULT_CODEX_FAST }),
    [patchCodex],
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

  const claudeEffort = state.claude.perModel[state.claude.model]?.effort ?? DEFAULT_CLAUDE_EFFORT;
  const codexReasoning = state.codex.perModel[state.codex.model]?.reasoning ?? DEFAULT_CODEX_REASONING;
  const codexFast = state.codex.perModel[state.codex.model]?.fast ?? DEFAULT_CODEX_FAST;
  const tourClaudeEffort = state.tourClaude.perModel[state.tourClaude.model]?.effort ?? DEFAULT_TOUR_CLAUDE_EFFORT;
  const tourCodexReasoning = state.tourCodex.perModel[state.tourCodex.model]?.reasoning ?? DEFAULT_TOUR_CODEX_REASONING;
  const tourCodexFast = state.tourCodex.perModel[state.tourCodex.model]?.fast ?? DEFAULT_TOUR_CODEX_FAST;
  const guideClaudeEffort = state.guideClaude.perModel[state.guideClaude.model]?.effort ?? DEFAULT_GUIDE_CLAUDE_EFFORT;
  const guideCodexReasoning = state.guideCodex.perModel[state.guideCodex.model]?.reasoning ?? DEFAULT_GUIDE_CODEX_REASONING;

  return {
    selectedMode: state.selectedMode,
    reviewEngine: state.reviewEngine,
    reviewProfileId: state.reviewProfileByEngine[state.reviewEngine] ?? BUILTIN_DEFAULT_PROFILE,
    tourEngine: state.tourEngine,
    guideEngine: state.guideEngine,
    claudeModel: state.claude.model,
    claudeEffort,
    codexModel: state.codex.model,
    codexReasoning,
    codexFast,
    cursorModel: state.cursor.model,
    opencodeModel: state.opencode.model,
    piModel: state.pi.model,
    piThinking: state.pi.thinking,
    copilotModel: state.copilot.model,
    tourClaudeModel: state.tourClaude.model,
    tourClaudeEffort,
    tourCodexModel: state.tourCodex.model,
    tourCodexReasoning,
    tourCodexFast,
    guideClaudeModel: state.guideClaude.model,
    guideClaudeEffort,
    guideCodexModel: state.guideCodex.model,
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
