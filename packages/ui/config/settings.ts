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

import { storage } from '../utils/storage';
import { generateIdentity } from '../utils/generateIdentity';

export interface SettingDef<T> {
  defaultValue: T | (() => T);
  fromCookie: () => T | undefined;
  toCookie: (value: T) => void;
  /** If set, this setting syncs to server via POST /api/config */
  serverKey?: string;
  fromServer?: (serverConfig: Record<string, unknown>) => T | undefined;
  toServer?: (value: T) => Record<string, unknown>;
}

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

  // --- Diff display options (namespaced under diffOptions in config.json) ---

  defaultDiffType: {
    defaultValue: 'unstaged' as 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all',
    fromCookie: () => {
      const v = storage.getItem('plannotator-default-diff-type');
      if (v === 'branch') return 'merge-base' as const;
      return v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
    },
    toCookie: (v: string) => storage.setItem('plannotator-default-diff-type', v),
    serverKey: 'diffOptions',
    fromServer: (sc: Record<string, unknown>) => {
      const v = (sc.diffOptions as Record<string, unknown> | undefined)?.defaultDiffType;
      if (v === 'branch') return 'merge-base' as const;
      return v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : undefined;
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
} satisfies Record<string, SettingDef<unknown>>;

export type SettingsMap = typeof SETTINGS;
export type SettingName = keyof SettingsMap;
