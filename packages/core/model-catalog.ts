/**
 * Model catalogs — the per-provider model lists every picker (Ask AI and the
 * review / Guided Review / Code Tour launchers) reads.
 *
 * The real lists come from the tool the user runs: Claude from the Agent SDK's
 * `supportedModels()` against the installed `claude`, Codex from the
 * app-server's `model/list`. Both are discovered lazily by the AI providers
 * and served on `/api/ai/capabilities?activate=<providerId>`. The fallbacks
 * below are used only when discovery fails or is unavailable. Browser-safe and
 * dependency-free: imported by the AI providers and by the UI.
 */

export interface CatalogModel {
  id: string;
  label: string;
  /** The provider's default pick (Ask AI's default; Codex's launcher default). */
  default?: boolean;
  /** Canonical model this id resolves to (Claude aliases, e.g. sonnet → claude-sonnet-5). */
  resolvedId?: string;
  /** Effort levels the model accepts; absent = the model takes no effort setting. */
  reasoningEfforts?: ReadonlyArray<{ id: string; label: string }>;
  defaultReasoningEffort?: string;
  /** Whether the model offers a fast service tier. */
  fastMode?: boolean;
}

export const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

export function effortList(ids: readonly string[]): Array<{ id: string; label: string }> {
  return ids.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
}

const CLAUDE_EFFORTS = effortList(['low', 'medium', 'high', 'xhigh', 'max']);
const claude = (id: string, label: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  label,
  reasoningEfforts: CLAUDE_EFFORTS,
  defaultReasoningEffort: 'high',
  ...extra,
});

export const CLAUDE_FALLBACK_MODELS: CatalogModel[] = [
  claude('opus', 'Opus (latest)'),
  claude('sonnet', 'Sonnet (latest)', { default: true }),
  claude('fable', 'Fable (latest)'),
  { id: 'haiku', label: 'Haiku (latest)' },
  claude('claude-fable-5-1', 'Fable 5.1'),
  claude('claude-opus-5-5', 'Opus 5.5'),
  claude('claude-sonnet-5', 'Sonnet 5'),
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const CODEX_EFFORTS = effortList(['low', 'medium', 'high', 'xhigh']);
export const CODEX_FALLBACK_MODELS: CatalogModel[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true, reasoningEfforts: CODEX_EFFORTS, defaultReasoningEffort: 'medium', fastMode: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: CODEX_EFFORTS, defaultReasoningEffort: 'medium', fastMode: true },
];

/** The subset of the Agent SDK's `ModelInfo` the catalog reads. */
export interface ClaudeSdkModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
  supportsFastMode?: boolean;
}

const CLAUDE_FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'];
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Build the Claude catalog from `supportedModels()`. Labels come from the
 * description's lead ("Opus 5.5 with 1M context · …"). The `default` row is a
 * pointer, not a model, so it is dropped. Every family the tool offers also
 * gets its bare latest alias (`opus`, `sonnet`, `fable`, `haiku`) — the CLI
 * accepts them and the launchers default to them — derived from the family's
 * first row so it carries the same effort / fast-mode support. `sonnet` is the
 * default pick (Ask AI's historical default).
 */
export function claudeCatalogFromSdk(infos: readonly ClaudeSdkModelInfo[]): CatalogModel[] {
  const rows: CatalogModel[] = [];
  for (const info of infos) {
    if (!info || typeof info.value !== 'string' || !info.value || info.value === 'default') continue;
    const lead = info.description?.split(' · ')[0]?.trim();
    const efforts = info.supportsEffort !== false ? (info.supportedEffortLevels ?? []) : [];
    rows.push({
      id: info.value,
      label: lead || info.displayName || info.value,
      ...(info.resolvedModel ? { resolvedId: info.resolvedModel } : {}),
      ...(efforts.length
        ? { reasoningEfforts: effortList(efforts), ...(efforts.includes('high') ? { defaultReasoningEffort: 'high' } : {}) }
        : {}),
      ...(info.supportsFastMode ? { fastMode: true } : {}),
    });
  }
  const aliases: CatalogModel[] = [];
  for (const family of CLAUDE_FAMILIES) {
    if (rows.some((r) => r.id === family)) continue;
    const source = rows.find((r) => r.id.startsWith(family) || (r.resolvedId ?? '').startsWith(`claude-${family}`));
    if (!source) continue;
    const { resolvedId: _, ...support } = source;
    aliases.push({ ...support, id: family, label: `${titleCase(family)} (latest)` });
  }
  const all = [...aliases, ...rows];
  const def = all.find((m) => m.id === 'sonnet') ?? all[0];
  return all.map((m) => (m === def ? { ...m, default: true } : m));
}

/**
 * Resolve a saved model choice against a catalog: keep it when the catalog
 * offers it (directly, or as the model an alias resolves to), otherwise fall
 * back to the surface's preferred default, then the catalog's own default.
 */
export function resolveModelChoice(saved: string, models: readonly CatalogModel[], preferred = ''): string {
  if (saved) {
    if (models.some((m) => m.id === saved)) return saved;
    const covering = models.find((m) => m.resolvedId === saved);
    if (covering) return covering.id;
  }
  if (preferred && models.some((m) => m.id === preferred)) return preferred;
  return (models.find((m) => m.default) ?? models[0])?.id ?? saved;
}

/**
 * Clamp an effort to what the model accepts: an unsupported effort snaps to
 * the model's default effort, a model without efforts yields ''. Unknown
 * models pass the effort through (their supported set is not known).
 */
export function resolveEffortChoice(effort: string, models: readonly CatalogModel[], modelId: string): string {
  const model = models.find((m) => m.id === modelId);
  if (!model) return effort;
  const efforts = model.reasoningEfforts ?? [];
  if (efforts.length === 0) return '';
  if (efforts.some((e) => e.id === effort)) return effort;
  return model.defaultReasoningEffort ?? efforts[0].id;
}

/** Picker options for a catalog; a current value the catalog lacks stays visible. */
export function modelSelectOptions(models: readonly CatalogModel[], current?: string): Array<{ value: string; label: string }> {
  const options = models.map((m) => ({ value: m.id, label: m.label }));
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  return options;
}

/** Effort picker options for one model — empty when it takes no effort setting. */
export function effortSelectOptions(models: readonly CatalogModel[], modelId: string): Array<{ value: string; label: string }> {
  const model = models.find((m) => m.id === modelId);
  return (model?.reasoningEfforts ?? []).map((e) => ({ value: e.id, label: e.label }));
}

/** Label for a model id, or the id itself when the catalog lacks it. */
export function modelLabel(models: readonly CatalogModel[], id: string): string {
  return models.find((m) => m.id === id)?.label ?? id;
}
