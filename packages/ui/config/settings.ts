/**
 * Settings registry — declares all config settings and their resolution rules.
 *
 * Each SettingDef describes:
 *   - defaultValue: fallback (can be a lazy factory for expensive defaults)
 *   - fromCookie/toCookie: serialization to/from cookie storage
 *   - serverKey + fromServer/toServer: opt-in sync to ~/.plannotator/config.json
 *
 * Add new settings here. Cookie-only settings omit serverKey.
 */

import type { DiffLineBgIntensity } from '@plannotator/core/config-types';
import { isFaviconStyle, type FaviconStyle } from '@plannotator/core/favicon';
import { storage } from '../utils/storage';
import { generateIdentity } from '../utils/generateIdentity';
import {
  getDefaultThemePair,
  normalizeThemePair,
  seedThemePair,
  type ThemePair,
} from '../utils/themeRegistry';
import { parseThemeMode } from '../components/themeModes';

/** Legacy single-palette key, still written so a downgrade renders styled. */
const COLOR_THEME_COOKIE = 'plannotator-color-theme';
const MODE_COOKIE = 'plannotator-theme';
const LIGHT_THEME_COOKIE = 'plannotator-light-theme';
const DARK_THEME_COOKIE = 'plannotator-dark-theme';

/**
 * Where a host keeps the two PRE-PAIR values, if not under Plannotator's own
 * keys. These mirror ThemeProvider's `storageKey` / `colorThemeStorageKey`
 * props, which existed before the pair and are what a host's already-stored
 * user preference lives under.
 *
 * Only these two legacy keys are overridable. The pair halves are a new
 * concept with no pre-existing host data, so they always use the fixed
 * `plannotator-light-theme` / `plannotator-dark-theme` keys; two hosts sharing
 * one origin with different key prefixes would share those halves.
 */
export interface ThemePairLegacyKeys {
  /** Where the mode is stored (ThemeProvider's `storageKey`). */
  mode?: string;
  /** Where the single pre-pair palette is stored (`colorThemeStorageKey`). */
  colorTheme?: string;
}

/**
 * Persist a pair to its cookies without touching the server.
 *
 * ThemeProvider calls this once it has resolved a pair, because a pair
 * migrated from the legacy single-palette key is DERIVED until it is written:
 * the provider then mirrors the active palette back onto that legacy key, so
 * leaving the halves underived would lose the migration on the next load.
 */
export function writeThemePairCookies(pair: ThemePair, keys?: ThemePairLegacyKeys): void {
  storage.setItem(keys?.mode ?? MODE_COOKIE, pair.mode);
  storage.setItem(LIGHT_THEME_COOKIE, pair.light);
  storage.setItem(DARK_THEME_COOKIE, pair.dark);
}

/**
 * Read the persisted pair, seeding either half from the single palette older
 * releases stored. Returns undefined only when the user has never expressed a
 * theme preference at all — ThemeProvider reads that as "my props decide".
 *
 * `keys` points the two legacy reads at a host's own storage keys so an
 * upgrade migrates that host's stored preference instead of discarding it.
 */
export function readThemePairCookies(keys?: ThemePairLegacyKeys): ThemePair | undefined {
  const mode = storage.getItem(keys?.mode ?? MODE_COOKIE);
  const light = storage.getItem(LIGHT_THEME_COOKIE);
  const dark = storage.getItem(DARK_THEME_COOKIE);
  const legacy = storage.getItem(keys?.colorTheme ?? COLOR_THEME_COOKIE);
  if (!mode && !light && !dark && !legacy) return undefined;
  const seeded = seedThemePair(legacy, parseThemeMode(mode, getDefaultThemePair().mode));
  return normalizeThemePair({ mode, light: light ?? seeded.light, dark: dark ?? seeded.dark }, seeded);
}

const DIFF_LINE_BG_INTENSITY_VALUES = ['subtle', 'normal', 'strong'] as const;
function isDiffLineBgIntensity(v: unknown): v is DiffLineBgIntensity {
  return typeof v === 'string' && (DIFF_LINE_BG_INTENSITY_VALUES as readonly string[]).includes(v);
}

export interface SettingDef<T> {
  defaultValue: T | (() => T);
  fromCookie: () => T | undefined;
  toCookie: (value: T) => void;
  /** If set, this setting syncs to server via POST /api/config */
  serverKey?: string;
  fromServer?: (serverConfig: Record<string, unknown>) => T | undefined;
  toServer?: (value: T) => Record<string, unknown>;
}

/** Typed registry of persisted UI settings and their storage codecs. */
export const SETTINGS = {
  displayName: {
    defaultValue: () => generateIdentity(),
    fromCookie: () => storage.getItem('plannotator-identity') || undefined,
    toCookie: (v: string) => storage.setItem('plannotator-identity', v),
    serverKey: 'displayName',
    fromServer: (sc: Record<string, unknown>) =>
      typeof sc.displayName === 'string' && sc.displayName ? sc.displayName : undefined,
    toServer: (v: string) => ({ displayName: v }),
  },

  /**
   * Appearance: the mode plus the palette assigned to each half of the pair.
   * Stored as one value because the three fields are only meaningful together —
   * `mode: system` picks between `light` and `dark` at render time.
   *
   * Cookies: `plannotator-theme` (mode) keeps its meaning, joined by
   * `plannotator-light-theme` / `plannotator-dark-theme`. A user arriving from
   * an older release has neither half, so the pair is seeded from the single
   * `plannotator-color-theme` palette they were on (ThemeProvider keeps writing
   * that key, so a downgrade still finds a palette and never renders unstyled).
   *
   * Server: round-trips through `theme` in ~/.plannotator/config.json exactly
   * like `diffOptions` does, so the choice survives the random port each hook
   * invocation runs on.
   */
  themePair: {
    defaultValue: () => getDefaultThemePair(),
    fromCookie: () => readThemePairCookies(),
    toCookie: (v: ThemePair) => writeThemePairCookies(v),
    serverKey: 'theme',
    fromServer: (sc: Record<string, unknown>) => {
      const theme = sc.theme as Record<string, unknown> | undefined;
      if (!theme || typeof theme !== 'object') return undefined;
      if (theme.mode === undefined && theme.light === undefined && theme.dark === undefined) return undefined;
      return normalizeThemePair(theme, getDefaultThemePair());
    },
    toServer: (v: ThemePair) => ({ theme: { mode: v.mode, light: v.light, dark: v.dark } }),
  },
  faviconStyle: {
    defaultValue: 'totman' as FaviconStyle,
    fromCookie: () => {
      const v = storage.getItem('plannotator-favicon');
      return isFaviconStyle(v) ? v : undefined;
    },
    toCookie: (v: FaviconStyle) => storage.setItem('plannotator-favicon', v),
    serverKey: 'favicon',
    fromServer: (sc: Record<string, unknown>) => {
      const v = sc.favicon;
      return isFaviconStyle(v) ? v : undefined;
    },
    toServer: (v: FaviconStyle) => ({ favicon: v }),
  },

  gridEnabled: {
    // Default ON: plans open in the classic grid / floating-card look. The UI 2.0
    // flat look is offered as an opt-in via the look-and-feel chooser dialog.
    defaultValue: true as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-grid-enabled');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-grid-enabled', String(v)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  vimModeEnabled: {
    // Vim bindings deliberately default OFF. Unmodified letter keys must remain
    // inert for existing users until they explicitly opt into modal document
    // navigation from Settings > Vim.
    defaultValue: false as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-vim-mode-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-vim-mode-enabled', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  vimHudEnabled: {
    // The larger command HUD is an optional presentation layer on top of Vim
    // controls. It has no effect while Vim mode itself is disabled.
    defaultValue: false as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-vim-hud-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-vim-hud-enabled', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  vimHudKeyPanelEnabled: {
    // Preserve the existing full HUD for current users while allowing the
    // bottom-right key panel to be hidden independently from the reticle.
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-vim-hud-key-panel-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-vim-hud-key-panel-enabled', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // --- Diff display options (namespaced under diffOptions in config.json) ---

  // Which left-panel view a code review OPENS in. 'sections' = the git-status
  // view (Committed/Changes/Untracked); 'tree' = the classic file tree.
  // Cookie-only. Written ONLY by Settings and the first-run setup dialog —
  // the in-review header toggle is session-scoped and never writes this
  // (looking at another view mid-review must not silently change the default).
  //
  // Deliberately NOT a value here: 'commits'. The Commits view is session-only
  // and never the opening view — a review always opens on files. A
  // previously-persisted 'commits' cookie is treated as unset.
  reviewPanelView: {
    defaultValue: 'sections' as 'sections' | 'tree',
    fromCookie: () => {
      const v = storage.getItem('plannotator-review-panel-view');
      return v === 'tree' || v === 'sections' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-review-panel-view', v),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // The view the user last SELECTED via the in-review header toggle. Layered
  // between the session state and the persisted reviewPanelView default, so a
  // new session opens on what the user was actually using. Cookie-only.
  // null = no last-used recorded (fall through to reviewPanelView).
  //
  // 'commits' is never recorded here for the same reason reviewPanelView
  // rejects it: the Commits view is session-only and never an opening view.
  reviewPanelViewLastUsed: {
    defaultValue: null as 'sections' | 'tree' | null,
    fromCookie: () => {
      const v = storage.getItem('plannotator-review-panel-view-last-used');
      return v === 'tree' || v === 'sections' ? v : undefined;
    },
    toCookie: (v: 'sections' | 'tree' | null) => {
      // The null default seeds through here on first load — "unrecorded" has
      // no cookie representation, so write nothing.
      if (v === 'sections' || v === 'tree') {
        storage.setItem('plannotator-review-panel-view-last-used', v);
      }
    },
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // Compact left-panel preferences. These are deliberately cookie-only: they
  // shape the local file-list chrome without changing review semantics or the
  // repository state, and should follow the reviewer across review sessions.
  reviewShowViewedControls: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-review-show-viewed-controls');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-review-show-viewed-controls', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  reviewShowStageControls: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-review-show-stage-controls');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-review-show-stage-controls', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  defaultDiffType: {
    defaultValue: 'since-base' as 'since-base' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all',
    fromCookie: () => {
      const v = storage.getItem('plannotator-default-diff-type');
      if (v === 'branch') return 'merge-base' as const;
      return v === 'since-base' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-default-diff-type', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.defaultDiffType;
      if (v === 'branch') return 'merge-base' as const;
      return v === 'since-base' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { defaultDiffType: v } }),
  },

  diffStyle: {
    defaultValue: 'split' as 'split' | 'unified',
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-style') ?? storage.getItem('review-diff-style');
      return v === 'split' || v === 'unified' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-diff-style', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.diffStyle;
      return v === 'split' || v === 'unified' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { diffStyle: v } }),
  },

  diffOverflow: {
    defaultValue: 'scroll' as 'scroll' | 'wrap',
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-overflow');
      return v === 'scroll' || v === 'wrap' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-diff-overflow', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.overflow;
      return v === 'scroll' || v === 'wrap' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { overflow: v } }),
  },

  diffIndicators: {
    defaultValue: 'bars' as 'bars' | 'classic' | 'none',
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-indicators');
      return v === 'bars' || v === 'classic' || v === 'none' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-diff-indicators', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.diffIndicators;
      return v === 'bars' || v === 'classic' || v === 'none' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { diffIndicators: v } }),
  },

  diffLineDiffType: {
    defaultValue: 'word-alt' as 'word-alt' | 'word' | 'char' | 'none',
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-line-diff-type');
      return v === 'word-alt' || v === 'word' || v === 'char' || v === 'none' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-diff-line-diff-type', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.lineDiffType;
      return v === 'word-alt' || v === 'word' || v === 'char' || v === 'none' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { lineDiffType: v } }),
  },

  diffShowLineNumbers: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-show-line-numbers');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-diff-show-line-numbers', String(v)),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.showLineNumbers;
      return typeof v === 'boolean' ? v : undefined;
    },
    toServer: (v: boolean) => ({ diffOptions: { showLineNumbers: v } }),
  },

  diffShowBackground: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-show-background');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-diff-show-background', String(v)),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.showDiffBackground;
      return typeof v === 'boolean' ? v : undefined;
    },
    toServer: (v: boolean) => ({ diffOptions: { showDiffBackground: v } }),
  },

  diffFontFamily: {
    defaultValue: '' as string, // empty = theme default
    fromCookie: () => storage.getItem('plannotator-diff-font-family') || undefined,
    toCookie: (v: string) => storage.setItem('plannotator-diff-font-family', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.fontFamily;
      return typeof v === 'string' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { fontFamily: v } }),
  },

  diffHideWhitespace: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-hide-whitespace');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-diff-hide-whitespace', String(v)),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.hideWhitespace;
      return typeof v === 'boolean' ? v : undefined;
    },
    toServer: (v: boolean) => ({ diffOptions: { hideWhitespace: v } }),
  },

  diffExpandUnchanged: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-expand-unchanged');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-diff-expand-unchanged', String(v)),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.expandUnchanged;
      return typeof v === 'boolean' ? v : undefined;
    },
    toServer: (v: boolean) => ({ diffOptions: { expandUnchanged: v } }),
  },

  diffFontSize: {
    defaultValue: '' as string, // empty = theme default
    fromCookie: () => storage.getItem('plannotator-diff-font-size') || undefined,
    toCookie: (v: string) => storage.setItem('plannotator-diff-font-size', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.fontSize;
      return typeof v === 'string' ? v : undefined;
    },
    toServer: (v: string) => ({ diffOptions: { fontSize: v } }),
  },
  diffTabSize: {
    defaultValue: 2 as number,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-tab-size');
      const n = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) && n >= 1 && n <= 8 ? n : undefined;
    },
    toCookie: (v: number) => storage.setItem('plannotator-diff-tab-size', String(v)),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.tabSize;
      return typeof v === 'number' && v >= 1 && v <= 8 ? v : undefined;
    },
    toServer: (v: number) => ({ diffOptions: { tabSize: v } }),
  },
  diffLineBgIntensity: {
    defaultValue: 'subtle' as DiffLineBgIntensity,
    fromCookie: () => {
      const v = storage.getItem('plannotator-diff-line-bg-intensity');
      return isDiffLineBgIntensity(v) ? v : undefined;
    },
    toCookie: (v: DiffLineBgIntensity) =>
      storage.setItem('plannotator-diff-line-bg-intensity', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.lineBgIntensity;
      return isDiffLineBgIntensity(v) ? v : undefined;
    },
    toServer: (v: DiffLineBgIntensity) => ({ diffOptions: { lineBgIntensity: v } }),
  },
  /** Experimental: author suggestions by editing code in place in the review
   *  all-files view. Cookie-only (no server sync) while the feature is
   *  experimental — default OFF, and when off no edit UI renders and no
   *  editor is ever constructed. (In code-split hosts the editor chunk is
   *  never fetched; Plannotator's single-file production build inlines all
   *  dynamic imports, so there the module namespace exists at page load —
   *  audited free of top-level side effects — but stays inert.) */
  editSuggestions: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-experimental-edit-suggestions');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) =>
      storage.setItem('plannotator-experimental-edit-suggestions', String(v)),
    serverKey: undefined,
    fromServer: undefined,
    toServer: undefined,
  },
  semanticDiffEnabled: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-semantic-diff-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-semantic-diff-enabled', String(value)),
    serverKey: 'reviewAnalysis',
    fromServer: (serverConfig: Record<string, unknown>) => {
      const value = (serverConfig.reviewAnalysis as Record<string, unknown> | undefined)?.semanticDiff;
      return typeof value === 'boolean' ? value : undefined;
    },
    toServer: (value: boolean) => ({ reviewAnalysis: { semanticDiff: value } }),
  },
  callFlowEnabled: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-call-flow-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-call-flow-enabled', String(value)),
    serverKey: 'reviewAnalysis',
    fromServer: (serverConfig: Record<string, unknown>) => {
      const value = (serverConfig.reviewAnalysis as Record<string, unknown> | undefined)?.callFlow;
      return typeof value === 'boolean' ? value : undefined;
    },
    toServer: (value: boolean) => ({ reviewAnalysis: { callFlow: value } }),
  },
  conventionalComments: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-conventional-comments');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-conventional-comments', String(v)),
    serverKey: 'conventionalComments',
    fromServer: (sc: Record<string, unknown>) => {
      const v = sc.conventionalComments;
      return typeof v === 'boolean' ? v : undefined;
    },
    toServer: (v: boolean) => ({ conventionalComments: v }),
  },
  /** JSON-serialized array of label configs, or null for defaults.
   *  Synced to ~/.plannotator/config.json as a parsed array (not a string). */
  conventionalLabels: {
    defaultValue: null as string | null,
    fromCookie: () => storage.getItem('plannotator-cc-labels') || undefined,
    toCookie: (v: string | null) => {
      if (v) storage.setItem('plannotator-cc-labels', v);
      else storage.removeItem('plannotator-cc-labels');
    },
    serverKey: 'conventionalLabels',
    fromServer: (sc: Record<string, unknown>) => {
      const v = sc.conventionalLabels;
      if (v === null) return null;
      if (Array.isArray(v)) return JSON.stringify(v);
      return undefined;
    },
    toServer: (v: string | null) => {
      if (v === null) return { conventionalLabels: null };
      try {
        return { conventionalLabels: JSON.parse(v) };
      } catch {
        return {};
      }
    },
  },
  /* SettingDef<any>, not <unknown>: consumers compile this shipped source under
     their own strictFunctionTypes, where a narrow `toCookie: (v: string) => void`
     is contravariantly incompatible with `(value: unknown) => void`. */
} satisfies Record<string, SettingDef<any>>;

export type SettingsMap = typeof SETTINGS;
export type SettingName = keyof SettingsMap;
