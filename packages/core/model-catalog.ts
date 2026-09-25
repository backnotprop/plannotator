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

const codex = (id: string, label: string, efforts: readonly string[], defaultReasoningEffort: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  label,
  reasoningEfforts: effortList(efforts),
  defaultReasoningEffort,
  fastMode: true,
  ...extra,
});
const CODEX_TO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
// What codex 0.155.1's `model/list` reports (GPT-6 is listed only to codex
// >= 0.155); every model offers the fast (`priority`) tier.
export const CODEX_FALLBACK_MODELS: CatalogModel[] = [
  codex('gpt-6-sol', 'GPT-6-Sol', CODEX_TO_ULTRA, 'medium', { default: true }),
  codex('gpt-6-astra', 'GPT-6-Astra', CODEX_TO_ULTRA, 'medium'),
  codex('gpt-6-luna', 'GPT-6-Luna', CODEX_TO_MAX, 'medium'),
  codex('gpt-5.6-sol', 'GPT-5.6-Sol', CODEX_TO_ULTRA, 'low'),
  codex('gpt-5.6-terra', 'GPT-5.6-Terra', CODEX_TO_ULTRA, 'medium'),
  codex('gpt-5.6-luna', 'GPT-5.6-Luna', CODEX_TO_MAX, 'medium'),
  codex('gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high', 'xhigh'], 'medium'),
];

/** Where a provider's model list came from: the installed tool, or the static fallback. */
export type ModelsSource = 'fallback' | 'discovered';

/**
 * The version in a CLI's own output: `claude --version` ("2.1.282 (Claude
 * Code)") or the codex app-server initialize `userAgent` ("plannotator/0.155.1
 * (Mac OS 26.3.0; arm64) …", where the first version is codex's).
 */
export function cliVersionFrom(text: string | null | undefined): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text ?? '')?.[1];
}

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
const ONE_M = '[1m]';
const isOneM = (id: string) => id.endsWith(ONE_M);

/** The Claude family an id names (`opus`, `opus[1m]`, `claude-opus-5-5` → `opus`). */
function claudeFamily(id: string): string | undefined {
  const bare = id.startsWith('claude-') ? id.slice('claude-'.length) : id;
  return CLAUDE_FAMILIES.find((family) => bare === family || bare.startsWith(`${family}-`) || bare === `${family}${ONE_M}`);
}

/**
 * The version a canonical Claude model id names: `claude-opus-5-5` → `5.5`,
 * `claude-sonnet-5` → `5`, `claude-haiku-4-5-20251001` → `4.5` (the date
 * suffix and any `[1m]` are ignored). Undefined when the id doesn't parse.
 */
export function claudeModelVersion(resolvedId: string | undefined): string | undefined {
  const match = /^claude-(?:opus|sonnet|fable|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(resolvedId ?? '');
  if (!match) return undefined;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

/**
 * Aliases read "Opus 5.5 (latest)" / "Opus 5.5 1M (latest)", the version taken
 * from the model the alias currently resolves to; without a parseable version
 * they read "Opus (latest)". Pinned ids return undefined (they keep their
 * model name). The SDK's displayName carries no version ("Opus (1M context)",
 * "Sonnet"), so the resolved id is the source.
 */
function aliasLabel(id: string, resolvedId?: string, fallbackVersion?: string): string | undefined {
  const family = CLAUDE_FAMILIES.find((f) => id === f || id === `${f}${ONE_M}`);
  if (!family) return undefined;
  const version = claudeModelVersion(resolvedId) ?? fallbackVersion;
  return `${titleCase(family)}${version ? ` ${version}` : ''}${isOneM(id) ? ' 1M' : ''} (latest)`;
}

/** Aliases the claude CLI always accepts; a discovered catalog always offers them. */
const CORE_CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

/** The family and version the SDK's `default` row points at: its resolvedModel, else its description. */
function defaultRowTarget(info: ClaudeSdkModelInfo): { family: string; version?: string } | undefined {
  const family = info.resolvedModel ? claudeFamily(info.resolvedModel) : undefined;
  if (family) return { family, version: claudeModelVersion(info.resolvedModel) };
  // Older CLIs: "Use the default model (currently Opus 4.7 (1M context))", no resolvedModel.
  // A number followed by `M` or more digits is a context size ("Opus 1M context"), not a version.
  const match = /\b(opus|sonnet|fable|haiku)\b(?:\s+(\d+(?:\.\d+)?)(?![\d.]|\s*M\b))?/i.exec(info.description ?? '');
  return match ? { family: match[1].toLowerCase(), version: match[2] } : undefined;
}

/**
 * Build the Claude catalog from `supportedModels()`. Labels come from the
 * description's lead ("Opus 5.5 with 1M context · …"). The `default` row is a
 * pointer, not a model, so it is not listed. Every family the tool offers also
 * gets its bare latest alias (`opus`, `sonnet`, `fable`, `haiku`) — the CLI
 * accepts them and the launchers default to them — derived from the family's
 * first row so it carries the same effort / fast-mode support. `opus`,
 * `sonnet` and `haiku` are always offered: some CLIs name a family only through
 * the `default` row (Claude Code 2.1.141 lists Opus nowhere else), and without
 * the alias a saved Opus pick would silently resolve to Sonnet. Such an alias
 * takes its version from the `default` row when that row points at the family,
 * and its support from the static fallback. `sonnet` is the default pick (Ask
 * AI's historical default).
 */
export function claudeCatalogFromSdk(infos: readonly ClaudeSdkModelInfo[]): CatalogModel[] {
  const rows: CatalogModel[] = [];
  let pointer: ClaudeSdkModelInfo | undefined;
  for (const info of infos) {
    if (!info || typeof info.value !== 'string' || !info.value) continue;
    if (info.value === 'default') {
      pointer ??= info;
      continue;
    }
    // Older Claude Code put the model name before ' · ' in `description`
    // ("Fable 5.1 · Most capable…"); 2.1.282+ puts it in `displayName` and
    // leaves `description` as a tagline only, so a description with no ' · '
    // must never become the label.
    const desc = info.description ?? '';
    const lead = (desc.includes(' · ') ? desc.split(' · ')[0].trim() : '') || info.displayName || info.value;
    const efforts = info.supportsEffort !== false ? (info.supportedEffortLevels ?? []) : [];
    rows.push({
      id: info.value,
      label: aliasLabel(info.value, info.resolvedModel) ?? (isOneM(info.value) && !/1M/i.test(lead) ? `${lead} (1M)` : lead),
      ...(info.resolvedModel ? { resolvedId: info.resolvedModel } : {}),
      ...(efforts.length
        ? { reasoningEfforts: effortList(efforts), ...(efforts.includes('high') ? { defaultReasoningEffort: 'high' } : {}) }
        : {}),
      ...(info.supportsFastMode ? { fastMode: true } : {}),
    });
  }
  if (rows.length === 0) return [];
  const target = pointer ? defaultRowTarget(pointer) : undefined;
  const aliases: CatalogModel[] = [];
  for (const family of CLAUDE_FAMILIES) {
    if (rows.some((r) => r.id === family)) continue;
    const source = rows.find((r) => claudeFamily(r.id) === family);
    if (source) {
      const { resolvedId: _, ...support } = source;
      aliases.push({ ...support, id: family, label: aliasLabel(family, source.resolvedId)! });
    } else if (CORE_CLAUDE_ALIASES.includes(family) || target?.family === family) {
      const { default: _, ...fallback } = CLAUDE_FALLBACK_MODELS.find((m) => m.id === family)!;
      const version = target?.family === family ? target.version : undefined;
      aliases.push({ ...fallback, label: aliasLabel(family, undefined, version)! });
    }
  }
  const all = [...aliases, ...rows];
  const def = all.find((m) => m.id === 'sonnet') ?? all[0];
  return all.map((m) => (m === def ? { ...m, default: true } : m));
}

/**
 * THE model resolver — Ask AI (client and server) and every launcher use it.
 * A saved pick resolves to, in order:
 *   1. itself, when the catalog offers it;
 *   2. the alias that covers it (`claude-sonnet-5` → `sonnet`);
 *   3. its family's alias (`claude-opus-5` → `opus`, `claude-sonnet-4-6` →
 *      `sonnet`), so a stale pin never silently changes model family;
 *   4. the surface's preferred default, then the catalog's own default.
 * Steps 2–3 never move a pick onto a 1M-context id unless the pick itself was
 * one — the context window (and its billing) is the user's choice.
 */
export function resolveModelChoice(saved: string, models: readonly CatalogModel[], preferred = ''): string {
  const offers = (id: string) => models.some((m) => m.id === id);
  if (saved) {
    if (offers(saved)) return saved;
    const covering = models.find((m) => m.resolvedId === saved && isOneM(m.id) === isOneM(saved));
    if (covering) return covering.id;
    const family = claudeFamily(saved);
    if (family) {
      if (isOneM(saved) && offers(`${family}${ONE_M}`)) return `${family}${ONE_M}`;
      if (offers(family)) return family;
    }
  }
  if (preferred && offers(preferred)) return preferred;
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

/** Label for a model id: the catalog's, else an alias's, else the id itself. */
export function modelLabel(models: readonly CatalogModel[], id: string): string {
  return models.find((m) => m.id === id)?.label ?? aliasLabel(id) ?? id;
}
