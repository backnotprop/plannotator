/**
 * Codex Model Catalog
 *
 * Single source of truth for the Codex models offered by the launch panels
 * (AgentsTab + GuideEmptyState) and their per-model reasoning efforts.
 * Aligned with the Codex CLI's own model catalog (codex-cli 0.144): each
 * entry carries the efforts that model actually accepts plus the CLI's
 * default effort for it, so the UI never offers (or launches) an effort the
 * model would reject. Lives in utils/ rather than AgentsTab so
 * useAgentSettings can clamp saved efforts without importing a component.
 */

export interface CodexModelOption {
  value: string;
  label: string;
  /** Reasoning efforts this model supports, per the Codex CLI catalog. */
  efforts: string[];
  /** The CLI's default effort for this model — the clamp target when a saved
   *  effort isn't in `efforts`. */
  defaultEffort: string;
}

// The two effort ladders in the current catalog. No model supports `minimal`
// anymore (saved picks migrate to `low` — see useAgentSettings).
const EFFORTS_THROUGH_XHIGH = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS_THROUGH_MAX = [...EFFORTS_THROUGH_XHIGH, 'max'];
const EFFORTS_THROUGH_ULTRA = [...EFFORTS_THROUGH_MAX, 'ultra'];

export const CODEX_MODELS: CodexModelOption[] = [
  // GPT-5.6 naming scheme: `-sol` is the flagship, `-terra` is the mid
  // price/performance tier, and `-luna` is the efficient high-volume tier.
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: EFFORTS_THROUGH_ULTRA, defaultEffort: 'low' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: EFFORTS_THROUGH_ULTRA, defaultEffort: 'medium' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: EFFORTS_THROUGH_MAX, defaultEffort: 'medium' },
  { value: 'gpt-5.5', label: 'GPT-5.5', efforts: EFFORTS_THROUGH_XHIGH, defaultEffort: 'medium' },
  { value: 'gpt-5.4', label: 'GPT-5.4', efforts: EFFORTS_THROUGH_XHIGH, defaultEffort: 'medium' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', efforts: EFFORTS_THROUGH_XHIGH, defaultEffort: 'high' },
  // gpt-5.2 is retained: it was retired from the ChatGPT product (steered to
  // 5.5) but the API still serves it, so API-key Codex users keep it. The
  // rest of the 5.2/5.1 family (gpt-5.2-codex, gpt-5.1-codex-max,
  // gpt-5.1-codex-mini — and gpt-5.3-codex before them) is API-shut-down per
  // OpenAI's deprecations page (2026-07-23), dead for ALL auth modes; saved
  // picks migrate in useAgentSettings. gpt-5.2 predates max/ultra, so it
  // gets the safe historical effort set.
  { value: 'gpt-5.2', label: 'GPT-5.2', efforts: EFFORTS_THROUGH_XHIGH, defaultEffort: 'medium' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', efforts: EFFORTS_THROUGH_XHIGH, defaultEffort: 'medium' },
];

/** Display labels for the reasoning-effort ids across every model. */
export const CODEX_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

// Fallback effort set for a model we don't know (a saved pick of a future
// model id passes through migration untouched, so the picker still needs
// SOMETHING to offer). low..xhigh is supported by every catalog model.
const UNKNOWN_MODEL_EFFORTS = EFFORTS_THROUGH_XHIGH;

/** The reasoning-effort picker options for one model — only the efforts that
 *  model actually supports. */
export function codexReasoningOptions(model: string): Array<{ value: string; label: string }> {
  const entry = CODEX_MODELS.find((m) => m.value === model);
  const efforts = entry?.efforts ?? UNKNOWN_MODEL_EFFORTS;
  return efforts.map((value) => ({ value, label: CODEX_EFFORT_LABELS[value] ?? value }));
}

/** Clamp a saved reasoning effort to what the model supports: an unsupported
 *  effort snaps to the model's catalog default effort. Unknown models pass
 *  through unchanged (we can't know their supported set). */
export function clampCodexReasoning(model: string, reasoning: string): string {
  const entry = CODEX_MODELS.find((m) => m.value === model);
  if (!entry) return reasoning;
  return entry.efforts.includes(reasoning) ? reasoning : entry.defaultEffort;
}
