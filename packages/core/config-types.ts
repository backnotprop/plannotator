export type DefaultDiffType = 'since-base' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all';
export type DiffLineBgIntensity = 'subtle' | 'normal' | 'strong';

/**
 * The user's appearance choice: a palette for the light half, a palette for
 * the dark half, and which of them the mode selects. `system` follows the OS,
 * so the two halves swap with `prefers-color-scheme`.
 */
export interface ThemeConfig {
  mode?: 'light' | 'dark' | 'system';
  light?: string;
  dark?: string;
}

export type TypographySurface = 'plan' | 'annotate' | 'review';
export type TypographyRole = 'display' | 'mono';
export const DISPLAY_TYPOGRAPHY_CATALOG_IDS = ['inter', 'atkinson-hyperlegible', 'ibm-plex-sans'] as const;
export const MONO_TYPOGRAPHY_CATALOG_IDS = ['jetbrains-mono', 'fira-code', 'ibm-plex-mono'] as const;
export const TYPOGRAPHY_CATALOG_IDS = [...DISPLAY_TYPOGRAPHY_CATALOG_IDS, ...MONO_TYPOGRAPHY_CATALOG_IDS] as const;
export type TypographyCatalogId = typeof TYPOGRAPHY_CATALOG_IDS[number];

export interface FontSelection {
  /** A trusted catalog id or a validated CSS font-family stack. */
  family: string;
  source: 'catalog' | 'custom';
}

export type SurfaceTypography = Partial<Record<TypographyRole, FontSelection>>;
export type TypographyConfig = Partial<Record<TypographySurface, SurfaceTypography>>;

export type TypographyParseResult =
  | { ok: true; value: TypographyConfig }
  | { ok: false };

const TYPOGRAPHY_SURFACES = new Set<TypographySurface>(['plan', 'annotate', 'review']);
const TYPOGRAPHY_ROLES = new Set<TypographyRole>(['display', 'mono']);
const DISPLAY_TYPOGRAPHY_CATALOG = new Set<string>(DISPLAY_TYPOGRAPHY_CATALOG_IDS);
const MONO_TYPOGRAPHY_CATALOG = new Set<string>(MONO_TYPOGRAPHY_CATALOG_IDS);

/** Strict trust boundary for typography from disk, cookies, and APIs. */
export function parseTypographyConfig(value: unknown): TypographyParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const parsed: TypographyConfig = {};
  for (const [surface, roles] of Object.entries(value)) {
    if (!TYPOGRAPHY_SURFACES.has(surface as TypographySurface) || !roles || typeof roles !== 'object' || Array.isArray(roles)) return { ok: false };
    const next: SurfaceTypography = {};
    for (const [role, selection] of Object.entries(roles as Record<string, unknown>)) {
      if (!TYPOGRAPHY_ROLES.has(role as TypographyRole) || !selection || typeof selection !== 'object' || Array.isArray(selection)) return { ok: false };
      const { family, source } = selection as Record<string, unknown>;
      const valid = typeof family === 'string' && typeof source === 'string' && (
        (source === 'catalog' && (role === 'display' ? DISPLAY_TYPOGRAPHY_CATALOG : MONO_TYPOGRAPHY_CATALOG).has(family)) ||
        (source === 'custom' && family.length > 0 && family.length <= 240 && !/[{};]/.test(family))
      );
      if (!valid) return { ok: false };
      next[role as TypographyRole] = { family, source: source as FontSelection['source'] };
    }
    parsed[surface as TypographySurface] = next;
  }
  return { ok: true, value: parsed };
}

export interface DiffOptions {
  diffStyle?: 'split' | 'unified';
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  showLineNumbers?: boolean;
  showDiffBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  tabSize?: number;
  hideWhitespace?: boolean;
  expandUnchanged?: boolean;
  defaultDiffType?: DefaultDiffType;
  lineBgIntensity?: DiffLineBgIntensity;
}
