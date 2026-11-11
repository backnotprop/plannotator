import {
  isAnnotateAgentTerminalSide,
  type AnnotateAgentTerminalSide,
} from '@plannotator/core/agent-terminal';
import type { DiffLineBgIntensity, ReviewDefaults } from '@plannotator/core/config-types';
import { DEFAULT_FAVICON_STYLE, isFaviconStyle, type FaviconStyle } from '@plannotator/core/favicon-style';
import {
  agentSwitchConfigValue,
  isAgentSwitchName,
  parseAgentSwitchConfig,
  type AgentSwitchChoice,
} from '@plannotator/core/agent-switch';
import {
  DEFAULT_TOKEN_HOVER_DELAY_MS,
  isTokenHoverDelay,
  resolveStoredTokenHoverTrigger,
  type TokenHoverDelay,
  type TokenHoverTrigger,
} from '@plannotator/core/token-hover';
import { DEFAULT_DIAGRAM_SHADOW, isDiagramShadow } from '../utils/diagramShadow';
import {
  DEFAULT_DOCUMENT_TEXT_SIZE,
  isDocumentTextSize,
  type DocumentTextSize,
} from '../utils/documentTextSize';
import { normalizeFontFamilyName } from '../utils/cssFontFamily';
import { storage } from '../utils/storage';
import { isLookChoiceResolved } from '../utils/lookAndFeelAnnouncement';
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

/** Where a host keeps the two PRE-PAIR values, if not under Plannotator's own keys. */
export interface ThemePairLegacyKeys {
  mode?: string;
  colorTheme?: string;
}

/** Persist a pair to its cookies without touching the server. */
export function writeThemePairCookies(pair: ThemePair, keys?: ThemePairLegacyKeys): void {
  storage.setItem(keys?.mode ?? MODE_COOKIE, pair.mode);
  storage.setItem(LIGHT_THEME_COOKIE, pair.light);
  storage.setItem(DARK_THEME_COOKIE, pair.dark);
}

/**
 * Returns undefined only when the user has never expressed a theme preference at all —
 * ThemeProvider reads that as "my props decide".
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

/** Pre-registry cookie keys of the agent switch, kept so an upgrade keeps the choice. */
const AGENT_SWITCH_COOKIE = 'plannotator-agent-switch';
const AGENT_SWITCH_CUSTOM_COOKIE = 'plannotator-agent-custom';

function readAgentSwitchCookies(): AgentSwitchChoice | undefined {
  const choice = parseAgentSwitchConfig(storage.getItem(AGENT_SWITCH_COOKIE));
  if (!choice) return undefined;
  const customName = storage.getItem(AGENT_SWITCH_CUSTOM_COOKIE);
  return isAgentSwitchName(customName) ? { switchTo: choice.switchTo, customName } : choice;
}

function writeAgentSwitchCookies(choice: AgentSwitchChoice | null): void {
  // null = never chosen: write nothing, so the surface default keeps applying.
  if (!choice) return;
  storage.setItem(AGENT_SWITCH_COOKIE, choice.switchTo);
  if (choice.customName) storage.setItem(AGENT_SWITCH_CUSTOM_COOKIE, choice.customName);
  // Custom with its name cleared: drop the old name, or the next read would
  // pair it with "custom" and switch to that old agent again.
  else if (choice.switchTo === 'custom') storage.removeItem(AGENT_SWITCH_CUSTOM_COOKIE);
}

const DIFF_LINE_BG_INTENSITY_VALUES = ['subtle', 'normal', 'strong'] as const;
function isDiffLineBgIntensity(v: unknown): v is DiffLineBgIntensity {
  return typeof v === 'string' && (DIFF_LINE_BG_INTENSITY_VALUES as readonly string[]).includes(v);
}

function parseReviewDefaults(value: unknown): ReviewDefaults | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const defaults: ReviewDefaults = {};
  for (const [providerId, providerValue] of Object.entries(value)) {
    if (!providerId || !providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) continue;
    const defaultDiffType = (providerValue as Record<string, unknown>).defaultDiffType;
    if (typeof defaultDiffType === 'string' && defaultDiffType) {
      defaults[providerId] = { defaultDiffType };
    }
  }
  return defaults;
}

export interface SettingDef<T> {
  defaultValue: T | (() => T);
  fromCookie: () => T | undefined;
  toCookie: (value: T) => void;
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
    defaultValue: DEFAULT_FAVICON_STYLE as FaviconStyle,
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
    defaultValue: false as boolean,
    fromCookie: () => {
      if (!isLookChoiceResolved()) return undefined;
      const v = storage.getItem('plannotator-grid-enabled');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-grid-enabled', String(v)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  diagramShadow: {
    defaultValue: DEFAULT_DIAGRAM_SHADOW as number,
    fromCookie: () => {
      // `Number(null)` and `Number('')` are 0, which is a VALID amount here (unlike the
      // token-hover steps), so an absent cookie must be rejected before the guard sees it —
      // otherwise no cookie reads as "no shadow".
      const raw = storage.getItem('plannotator-diagram-shadow');
      if (raw === null || raw.trim() === '') return undefined;
      const parsed = Number(raw);
      return isDiagramShadow(parsed) ? parsed : undefined;
    },
    toCookie: (value: number) => storage.setItem('plannotator-diagram-shadow', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  documentTextSize: {
    defaultValue: DEFAULT_DOCUMENT_TEXT_SIZE as DocumentTextSize,
    fromCookie: () => {
      const raw = storage.getItem('plannotator-document-text-size');
      if (raw === null || raw.trim() === '') return undefined;
      const parsed = Number(raw);
      return isDocumentTextSize(parsed) ? parsed : undefined;
    },
    toCookie: (value: DocumentTextSize) =>
      storage.setItem('plannotator-document-text-size', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  documentFontFamily: {
    defaultValue: '' as string,
    fromCookie: () =>
      normalizeFontFamilyName(storage.getItem('plannotator-document-font-family') ?? '') || undefined,
    toCookie: (value: string) => storage.setItem('plannotator-document-font-family', value),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  enterSavesComment: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-enter-saves-comment');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-enter-saves-comment', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  hideRepoOwner: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-hide-repo-owner');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-hide-repo-owner', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  vimModeEnabled: {
    // Vim bindings deliberately default OFF.
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
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-vim-hud-key-panel-enabled');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-vim-hud-key-panel-enabled', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  reviewPanelView: {
    defaultValue: 'tree' as 'sections' | 'tree',
    fromCookie: () => {
      const v = storage.getItem('plannotator-review-panel-view');
      return v === 'tree' || v === 'sections' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-review-panel-view', v),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // Layered between the session state and the persisted reviewPanelView default, so a new session
  // opens on what the user was actually using.
  reviewPanelViewLastUsed: {
    defaultValue: null as 'sections' | 'tree' | null,
    fromCookie: () => {
      const v = storage.getItem('plannotator-review-panel-view-last-used');
      return v === 'tree' || v === 'sections' ? v : undefined;
    },
    toCookie: (v: 'sections' | 'tree' | null) => {
      if (v === 'sections' || v === 'tree') {
        storage.setItem('plannotator-review-panel-view-last-used', v);
      }
    },
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // Compact left-panel preferences. These are deliberately cookie-only: they shape the local
  // file-list chrome without changing review semantics or the repository state, and should follow
  // the reviewer across review sessions.
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

  // Cookie-only like the other review-chrome preferences: it shapes how the local file list checks
  // itself off and changes no review semantics (viewed gates nothing on submit).
  reviewAutoViewed: {
    defaultValue: true as boolean,
    fromCookie: () => {
      const value = storage.getItem('plannotator-review-auto-viewed');
      return value === 'true' ? true : value === 'false' ? false : undefined;
    },
    toCookie: (value: boolean) =>
      storage.setItem('plannotator-review-auto-viewed', String(value)),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  // Cookie-only like the other review-chrome preferences: it is presentational, per-browser, and
  // changes no review semantics — `off` simply means no listeners, no requests and no card.
  tokenHoverTrigger: {
    defaultValue: 'hover' as TokenHoverTrigger,
    fromCookie: () => resolveStoredTokenHoverTrigger(
      storage.getItem('plannotator-token-hover-trigger'),
      storage.getItem('plannotator-token-hover-cards'),
    ),
    toCookie: (value: TokenHoverTrigger) =>
      storage.setItem('plannotator-token-hover-trigger', value),
    serverKey: undefined, fromServer: undefined, toServer: undefined,
  },

  tokenHoverDelay: {
    defaultValue: DEFAULT_TOKEN_HOVER_DELAY_MS as TokenHoverDelay,
    fromCookie: () => {
      const parsed = Number(storage.getItem('plannotator-token-hover-delay'));
      return isTokenHoverDelay(parsed) ? parsed : undefined;
    },
    toCookie: (value: TokenHoverDelay) =>
      storage.setItem('plannotator-token-hover-delay', String(value)),
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

  reviewDefaults: {
    defaultValue: {} as ReviewDefaults,
    fromCookie: () => {
      const value = storage.getItem('plannotator-review-defaults');
      if (!value) return undefined;
      try {
        return parseReviewDefaults(JSON.parse(value));
      } catch {
        return undefined;
      }
    },
    toCookie: (value: ReviewDefaults) =>
      storage.setItem('plannotator-review-defaults', JSON.stringify(value)),
    serverKey: 'reviewDefaults',
    fromServer: (serverConfig: Record<string, unknown>) =>
      parseReviewDefaults(serverConfig.reviewDefaults),
    toServer: (value: ReviewDefaults) => ({ reviewDefaults: value }),
  },

  defaultDiffType: {
    defaultValue: 'since-base' as 'since-base' | 'local-vs-remote' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all',
    fromCookie: () => {
      const v = storage.getItem('plannotator-default-diff-type');
      if (v === 'branch') return 'merge-base' as const;
      return v === 'since-base' || v === 'local-vs-remote' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-default-diff-type', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.defaultDiffType;
      if (v === 'branch') return 'merge-base' as const;
      return v === 'since-base' || v === 'local-vs-remote' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
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
  /**
   * (In code-split hosts the editor chunk is never fetched; Plannotator's single-file production
   * build inlines all dynamic imports, so there the module namespace exists at page load —
   * audited free of top-level side effects — but stays inert.)
   */
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
  /**
   * The server always sends the config-file value (default false), so the cookie is only a
   * mirror and can never turn this on by itself.
   */
  autoUpdate: {
    defaultValue: false as boolean,
    fromCookie: () => {
      const v = storage.getItem('plannotator-auto-update');
      return v === 'true' ? true : v === 'false' ? false : undefined;
    },
    toCookie: (v: boolean) => storage.setItem('plannotator-auto-update', String(v)),
    serverKey: 'autoUpdate',
    fromServer: (sc: Record<string, unknown>) =>
      typeof sc.autoUpdate === 'boolean' ? sc.autoUpdate : undefined,
    toServer: (v: boolean) => ({ autoUpdate: v }),
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
  /**
   * Server-synced to `agentSwitch` in ~/.plannotator/config.json because some webviews
   * (Glimpse's WKWebView) keep no cookies between runs, and a lost choice silently hands the
   * session to the build agent.
   */
  agentSwitch: {
    defaultValue: null as AgentSwitchChoice | null,
    fromCookie: () => readAgentSwitchCookies(),
    toCookie: (v: AgentSwitchChoice | null) => writeAgentSwitchCookies(v),
    serverKey: 'agentSwitch',
    fromServer: (sc: Record<string, unknown>) => {
      const choice = parseAgentSwitchConfig(sc.agentSwitch);
      // Custom with no name means no switch: never pair it with an old name.
      if (!choice || choice.customName || choice.switchTo === 'custom') return choice;
      const customName = storage.getItem(AGENT_SWITCH_CUSTOM_COOKIE);
      return isAgentSwitchName(customName) ? { ...choice, customName } : choice;
    },
    toServer: (v: AgentSwitchChoice | null) => {
      const value = v ? agentSwitchConfigValue(v) : undefined;
      return value === undefined ? {} : { agentSwitch: value };
    },
  },
  /**
   * Server-synced so the placement survives the random port every annotate session runs on — a
   * cookie alone is per-origin, and each invocation is a new origin, so a cookie-only preference
   * is effectively per-session.
   */
  agentTerminalSide: {
    defaultValue: 'left' as AnnotateAgentTerminalSide,
    fromCookie: () => {
      const v = storage.getItem('plannotator-annotate-agent-terminal-side');
      return isAnnotateAgentTerminalSide(v) ? v : undefined;
    },
    toCookie: (v: AnnotateAgentTerminalSide) =>
      storage.setItem('plannotator-annotate-agent-terminal-side', v),
    serverKey: 'agentTerminalSide',
    fromServer: (sc: Record<string, unknown>) =>
      isAnnotateAgentTerminalSide(sc.agentTerminalSide) ? sc.agentTerminalSide : undefined,
    toServer: (v: AnnotateAgentTerminalSide) => ({ agentTerminalSide: v }),
  },
  agentTerminalDefaultAgent: {
    defaultValue: '' as string,
    fromCookie: () =>
      storage.getItem('plannotator-annotate-agent-terminal-default') || undefined,
    toCookie: (v: string) => {
      if (v) storage.setItem('plannotator-annotate-agent-terminal-default', v);
      else storage.removeItem('plannotator-annotate-agent-terminal-default');
    },
    serverKey: 'agentTerminalDefaultAgent',
    fromServer: (sc: Record<string, unknown>) =>
      typeof sc.agentTerminalDefaultAgent === 'string' && sc.agentTerminalDefaultAgent
        ? sc.agentTerminalDefaultAgent
        : undefined,
    toServer: (v: string) => ({ agentTerminalDefaultAgent: v }),
  },
  /*
   * SettingDef<any>, not <unknown>: consumers compile this shipped source under their own
   * strictFunctionTypes, where a narrow `toCookie: (v: string) => void` is contravariantly
   * incompatible with `(value: unknown) => void`.
   */
} satisfies Record<string, SettingDef<any>>;

export type SettingsMap = typeof SETTINGS;
export type SettingName = keyof SettingsMap;
