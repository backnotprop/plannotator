export interface CatalogModel {
  id: string;
  label: string;
  default?: boolean;
  resolvedId?: string;
  reasoningEfforts?: ReadonlyArray<{ id: string; label: string }>;
  defaultReasoningEffort?: string;
  fastMode?: boolean;
}

export const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
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

/** Every thinking level Pi names, in its own order (pi-ai's `EXTENDED_THINKING_LEVELS`). */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The first pi whose RPC `set_thinking_level` (and `set_model`) change only the running session. */
export const PI_SESSION_SCOPED_THINKING_VERSION = '0.84.3';

function parseVersionTriple(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Whether Plannotator may set a thinking level on a pi of this version (see
 * `PI_SESSION_SCOPED_THINKING_VERSION`).
 */
export function piThinkingLevelsSupported(version: string | undefined): boolean {
  const actual = version ? parseVersionTriple(version) : undefined;
  const minimum = parseVersionTriple(PI_SESSION_SCOPED_THINKING_VERSION)!;
  if (!actual) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

/** The thinking levels one Pi model accepts, from its `get_available_models` row. */
export function piSupportedThinkingLevels(
  reasoning: boolean | undefined,
  thinkingLevelMap?: Readonly<Record<string, string | null | undefined>> | null,
): string[] {
  if (!reasoning) return [];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** The subset of a pi `get_available_models` row the catalog reads. */
export interface PiRpcModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined> | null;
}

/** Build the Pi catalog from `get_available_models`. */
export function piCatalogFromRpc(rows: readonly PiRpcModel[], toolVersion: string | undefined): CatalogModel[] {
  const valid = rows.filter((m) => m && typeof m.provider === 'string' && m.provider && typeof m.id === 'string' && m.id);
  const withLevels = piThinkingLevelsSupported(toolVersion);
  const labelOf = (m: PiRpcModel) => `${(typeof m.name === 'string' && m.name.trim()) || m.id} (${m.provider})`;
  const counts = new Map<string, number>();
  for (const m of valid) counts.set(labelOf(m), (counts.get(labelOf(m)) ?? 0) + 1);
  return valid.map((m, i) => {
    const label = labelOf(m);
    const levels = withLevels ? piSupportedThinkingLevels(m.reasoning, m.thinkingLevelMap) : [];
    return {
      id: `${m.provider}/${m.id}`,
      label: (counts.get(label) ?? 0) > 1 ? `${m.provider}/${m.id}` : label,
      ...(i === 0 ? { default: true } : {}),
      ...(levels.length ? { reasoningEfforts: effortList(levels) } : {}),
    };
  });
}

/** The subset of one Qwen Code `modelProviders.<authType>[]` entry the catalog reads. */
export interface QwenSettingsModel {
  id?: unknown;
  name?: unknown;
}

/** Build the Qwen Code catalog from its `settings.json` (already parsed), so no `qwen` process runs. */
export function qwenCatalogFromSettings(settings: unknown): CatalogModel[] {
  if (!settings || typeof settings !== 'object') return [];
  const root = settings as {
    model?: { name?: unknown };
    modelProviders?: Record<string, unknown>;
    security?: { auth?: { selectedType?: unknown } };
  };
  const selected = root.security?.auth?.selectedType;
  const authType = typeof selected === 'string' && selected.trim() ? selected.trim() : 'openai';
  const entries = root.modelProviders && typeof root.modelProviders === 'object' ? root.modelProviders[authType] : undefined;
  const rows: CatalogModel[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name } = entry as QwenSettingsModel;
    if (typeof id !== 'string' || !id.trim() || rows.some((r) => r.id === id.trim())) continue;
    rows.push({ id: id.trim(), label: (typeof name === 'string' && name.trim()) || id.trim() });
  }
  const active = typeof root.model?.name === 'string' ? root.model.name.trim() : '';
  if (active && !rows.some((r) => r.id === active)) rows.unshift({ id: active, label: active });
  const defaultId = active || rows[0]?.id;
  return rows.map((r) => (r.id === defaultId ? { ...r, default: true } : r));
}

export function cliVersionFrom(text: string | null | undefined, toolLine?: RegExp): string | undefined {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim());
  const line = (toolLine && lines.find((l) => toolLine.test(l))) ?? lines[0] ?? '';
  return /\b(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,24})?)(?![0-9A-Za-z.-])/.exec(line)?.[1];
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

function claudeFamily(id: string): string | undefined {
  const bare = id.startsWith('claude-') ? id.slice('claude-'.length) : id;
  return CLAUDE_FAMILIES.find((family) => bare === family || bare.startsWith(`${family}-`) || bare === `${family}${ONE_M}`);
}

export function claudeModelVersion(resolvedId: string | undefined): string | undefined {
  const match = /^claude-(?:opus|sonnet|fable|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(resolvedId ?? '');
  if (!match) return undefined;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function aliasLabel(id: string, resolvedId?: string, fallbackVersion?: string): string | undefined {
  const family = CLAUDE_FAMILIES.find((f) => id === f || id === `${f}${ONE_M}`);
  if (!family) return undefined;
  const version = claudeModelVersion(resolvedId) ?? fallbackVersion;
  return `${titleCase(family)}${version ? ` ${version}` : ''}${isOneM(id) ? ' 1M' : ''} (latest)`;
}

const CORE_CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

function defaultRowTarget(info: ClaudeSdkModelInfo): { family: string; version?: string } | undefined {
  const family = info.resolvedModel ? claudeFamily(info.resolvedModel) : undefined;
  if (family) return { family, version: claudeModelVersion(info.resolvedModel) };
  const match = /\b(opus|sonnet|fable|haiku)\b(?:\s+(\d+(?:\.\d+)?)(?![\d.]|\s*M\b))?/i.exec(info.description ?? '');
  return match ? { family: match[1].toLowerCase(), version: match[2] } : undefined;
}

/** Build the Claude catalog from `supportedModels()`. */
export function claudeCatalogFromSdk(infos: readonly ClaudeSdkModelInfo[]): CatalogModel[] {
  const rows: CatalogModel[] = [];
  let pointer: ClaudeSdkModelInfo | undefined;
  for (const info of infos) {
    if (!info || typeof info.value !== 'string' || !info.value) continue;
    if (info.value === 'default') {
      pointer ??= info;
      continue;
    }
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

/** THE model resolver — Ask AI (client and server) and every launcher use it. */
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
 * Clamp an effort to what the model accepts: an unsupported effort snaps to the model's default
 * effort, a model without efforts yields ''.
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
