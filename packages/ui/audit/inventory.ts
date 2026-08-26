import {
  parseCssColor,
  compositeColors,
  mixColors,
  type RGBA,
  type ColorResolutionContext,
} from './color';
import type { ThemeTokens } from './cssParser';

export type SemanticCategory =
  | 'core-text'
  | 'muted-text'
  | 'action'
  | 'status-text'
  | 'component-boundary'
  | 'diff-state'
  | 'annotation';

export type WcagCriterion = 'SC 1.4.3' | 'SC 1.4.3 Large' | 'SC 1.4.11';

export interface SemanticStateDefinition {
  id: string;
  name: string;
  category: SemanticCategory;
  criterion: WcagCriterion;
  targetRatio: number; // 4.5 or 3.0
  isLargeText: boolean;
  isNonText: boolean;
  source: string;
  description: string;
  resolve: (tokens: ThemeTokens) => {
    fg: RGBA;
    bg: RGBA;
    fgExpression: string;
    bgExpression: string;
    tokenNames: string[];
  };
}

function resolveTokenOrFallback(
  tokens: ThemeTokens,
  name: string,
  fallbackExpr: string
): RGBA {
  const resolved = tokens.resolvedColors[name];
  if (resolved) return resolved;
  if (tokens.rawTokens[name] !== undefined) {
    throw new Error(
      `Token '${name}' is present but unresolved in theme '${tokens.themeId}:${tokens.mode}': ${tokens.rawTokens[name]}`,
    );
  }
  const ctx: ColorResolutionContext = {
    resolveVar: (n: string) => tokens.rawTokens[n],
  };
  const parsedFallback = parseCssColor(fallbackExpr, ctx);
  if (parsedFallback) return parsedFallback;

  throw new Error(`Failed to resolve token '${name}' in theme '${tokens.themeId}:${tokens.mode}'`);
}

function createTokenContext(tokens: ThemeTokens): ColorResolutionContext {
  return {
    resolveVar: (n: string) => tokens.rawTokens[n],
  };
}

export const SEMANTIC_INVENTORY: SemanticStateDefinition[] = [
  // ---------------------------------------------------------------------------
  // 1. Core Surfaces & Primary Text (SC 1.4.3 — 4.5:1)
  // ---------------------------------------------------------------------------
  {
    id: 'text-page',
    name: 'Page text on background',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: 'body / text-foreground on bg-background',
    description: 'Main application body text against the root background surface.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--foreground', '#ffffff'),
      bg: resolveTokenOrFallback(t, '--background', '#000000'),
      fgExpression: 'var(--foreground)',
      bgExpression: 'var(--background)',
      tokenNames: ['--foreground', '--background'],
    }),
  },
  {
    id: 'text-card',
    name: 'Card text on card surface',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-card .text-card-foreground',
    description: 'Plan document view card and panel headers against card surface.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--card-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--card-foreground)',
      bgExpression: 'var(--card)',
      tokenNames: ['--card-foreground', '--card'],
    }),
  },
  {
    id: 'text-popover',
    name: 'Popover text on popover surface',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-popover .text-popover-foreground',
    description: 'Dropdowns, tooltip content, and comment popovers.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--popover-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--popover', 'var(--card)'),
      fgExpression: 'var(--popover-foreground)',
      bgExpression: 'var(--popover)',
      tokenNames: ['--popover-foreground', '--popover'],
    }),
  },
  {
    id: 'text-sidebar',
    name: 'Sidebar text on sidebar surface',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-sidebar .text-sidebar-foreground',
    description: 'Left drawer navigation, Table of Contents, Version and Archive browsers.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--sidebar-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--sidebar', 'var(--card)'),
      fgExpression: 'var(--sidebar-foreground)',
      bgExpression: 'var(--sidebar)',
      tokenNames: ['--sidebar-foreground', '--sidebar'],
    }),
  },
  {
    id: 'text-sidebar-accent',
    name: 'Sidebar active/hover item text on sidebar accent',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-sidebar-accent .text-sidebar-accent-foreground',
    description: 'Active tab or selected document item in the sidebar.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--sidebar-accent-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--sidebar-accent', 'var(--muted)'),
      fgExpression: 'var(--sidebar-accent-foreground)',
      bgExpression: 'var(--sidebar-accent)',
      tokenNames: ['--sidebar-accent-foreground', '--sidebar-accent'],
    }),
  },
  {
    id: 'text-code-block',
    name: 'Code block fallback text on code background',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: 'pre > code.pn-code on var(--code-bg)',
    description: 'Unsyntaxed fenced code blocks and inline code tags.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--foreground', '#ffffff'),
      bg: resolveTokenOrFallback(t, '--code-bg', 'var(--muted)'),
      fgExpression: 'var(--foreground)',
      bgExpression: 'var(--code-bg)',
      tokenNames: ['--foreground', '--code-bg'],
    }),
  },
  {
    id: 'text-surface-0',
    name: 'Text on surface-0 (lowest elevated surface)',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: 'var(--foreground) on var(--surface-0)',
    description: 'Elevated panel canvas (40% muted mix with background).',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--foreground', '#ffffff'),
      bg: resolveTokenOrFallback(t, '--surface-0', 'color-mix(in oklch, var(--muted) 40%, var(--background))'),
      fgExpression: 'var(--foreground)',
      bgExpression: 'var(--surface-0)',
      tokenNames: ['--foreground', '--surface-0', '--muted', '--background'],
    }),
  },
  {
    id: 'text-surface-1',
    name: 'Text on surface-1 (muted container)',
    category: 'core-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: 'var(--foreground) on var(--surface-1)',
    description: 'Muted surface background container.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--foreground', '#ffffff'),
      bg: resolveTokenOrFallback(t, '--surface-1', 'var(--muted)'),
      fgExpression: 'var(--foreground)',
      bgExpression: 'var(--surface-1)',
      tokenNames: ['--foreground', '--surface-1', '--muted'],
    }),
  },

  // ---------------------------------------------------------------------------
  // 2. Muted Text & Secondary Hierarchy (SC 1.4.3 — 4.5:1)
  // ---------------------------------------------------------------------------
  {
    id: 'muted-on-page',
    name: 'Muted text on background',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-muted-foreground on bg-background',
    description: 'Timestamps, secondary metadata, and descriptions on page.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--muted-foreground', '#888888'),
      bg: resolveTokenOrFallback(t, '--background', '#000000'),
      fgExpression: 'var(--muted-foreground)',
      bgExpression: 'var(--background)',
      tokenNames: ['--muted-foreground', '--background'],
    }),
  },
  {
    id: 'muted-on-card',
    name: 'Muted text on card',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-muted-foreground on bg-card',
    description: 'Document subtitles, line numbers, and author tags inside cards.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--muted-foreground', '#888888'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--muted-foreground)',
      bgExpression: 'var(--card)',
      tokenNames: ['--muted-foreground', '--card'],
    }),
  },
  {
    id: 'muted-on-popover',
    name: 'Muted text on popover',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-muted-foreground on bg-popover',
    description: 'Shortcut hint badges and helper text inside menus and popovers.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--muted-foreground', '#888888'),
      bg: resolveTokenOrFallback(t, '--popover', 'var(--card)'),
      fgExpression: 'var(--muted-foreground)',
      bgExpression: 'var(--popover)',
      tokenNames: ['--muted-foreground', '--popover'],
    }),
  },
  {
    id: 'muted-on-muted',
    name: 'Muted text on muted container fill',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-muted-foreground on bg-muted',
    description: 'Secondary metadata inside table headers or blockquote fills.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--muted-foreground', '#888888'),
      bg: resolveTokenOrFallback(t, '--muted', 'var(--card)'),
      fgExpression: 'var(--muted-foreground)',
      bgExpression: 'var(--muted)',
      tokenNames: ['--muted-foreground', '--muted'],
    }),
  },
  {
    id: 'secondary-text-page',
    name: 'Secondary text on background',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-secondary-foreground on bg-background',
    description: 'Secondary labels across settings and footer rows.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--secondary-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--background', '#000000'),
      fgExpression: 'var(--secondary-foreground)',
      bgExpression: 'var(--background)',
      tokenNames: ['--secondary-foreground', '--background'],
    }),
  },
  {
    id: 'secondary-text-card',
    name: 'Secondary text on card',
    category: 'muted-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-secondary-foreground on bg-card',
    description: 'Secondary labels and actions in card panels.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--secondary-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--secondary-foreground)',
      bgExpression: 'var(--card)',
      tokenNames: ['--secondary-foreground', '--card'],
    }),
  },

  // ---------------------------------------------------------------------------
  // 3. Action & Button Pairs (SC 1.4.3 — 4.5:1)
  // ---------------------------------------------------------------------------
  {
    id: 'btn-primary',
    name: 'Primary button text on primary fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-primary .text-primary-foreground',
    description: 'Approve button, primary CTAs, active segmented toggles.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--primary-foreground', '#000000'),
      bg: resolveTokenOrFallback(t, '--primary', '#3b82f6'),
      fgExpression: 'var(--primary-foreground)',
      bgExpression: 'var(--primary)',
      tokenNames: ['--primary-foreground', '--primary'],
    }),
  },
  {
    id: 'btn-secondary',
    name: 'Secondary button text on secondary fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-secondary .text-secondary-foreground',
    description: 'Dismiss/Cancel buttons, secondary action chips.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--secondary-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--secondary', 'var(--muted)'),
      fgExpression: 'var(--secondary-foreground)',
      bgExpression: 'var(--secondary)',
      tokenNames: ['--secondary-foreground', '--secondary'],
    }),
  },
  {
    id: 'btn-accent',
    name: 'Accent button text on accent fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-accent .text-accent-foreground',
    description: 'Highlighted action buttons, comment action pills.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--accent-foreground', 'var(--foreground)'),
      bg: resolveTokenOrFallback(t, '--accent', 'var(--primary)'),
      fgExpression: 'var(--accent-foreground)',
      bgExpression: 'var(--accent)',
      tokenNames: ['--accent-foreground', '--accent'],
    }),
  },
  {
    id: 'btn-destructive',
    name: 'Destructive button text on destructive fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-destructive .text-destructive-foreground',
    description: 'Deny button, delete annotation, kill agent job actions.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--destructive-foreground', '#ffffff'),
      bg: resolveTokenOrFallback(t, '--destructive', '#ef4444'),
      fgExpression: 'var(--destructive-foreground)',
      bgExpression: 'var(--destructive)',
      tokenNames: ['--destructive-foreground', '--destructive'],
    }),
  },
  {
    id: 'btn-success',
    name: 'Success button text on success fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-success .text-success-foreground',
    description: 'Confirmed badge actions, submit review approval.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--success-foreground', '#000000'),
      bg: resolveTokenOrFallback(t, '--success', '#22c55e'),
      fgExpression: 'var(--success-foreground)',
      bgExpression: 'var(--success)',
      tokenNames: ['--success-foreground', '--success'],
    }),
  },
  {
    id: 'btn-warning',
    name: 'Warning button text on warning fill',
    category: 'action',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-warning .text-warning-foreground',
    description: 'Staleness warning actions, retry buttons.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--warning-foreground', '#000000'),
      bg: resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)'),
      fgExpression: 'var(--warning-foreground)',
      bgExpression: 'var(--warning)',
      tokenNames: ['--warning-foreground', '--warning'],
    }),
  },

  // ---------------------------------------------------------------------------
  // 4. Status Colors & Tinted Badges (SC 1.4.3 — 4.5:1)
  // ---------------------------------------------------------------------------
  {
    id: 'status-destructive-card',
    name: 'Destructive text on card',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-destructive on bg-card',
    description: 'Error messages, validation warnings, deletion counts.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--destructive', '#ef4444'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--destructive)',
      bgExpression: 'var(--card)',
      tokenNames: ['--destructive', '--card'],
    }),
  },
  {
    id: 'status-destructive-pill',
    name: 'Destructive text on 15% tinted destructive pill',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-destructive on .bg-destructive/15 inside bg-card',
    description: 'Denied plan badge, error status pill.',
    resolve: (t) => {
      const cardBg = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const dest = resolveTokenOrFallback(t, '--destructive', '#ef4444');
      const mixedBg = mixColors('srgb', dest, 15, cardBg, 85);
      return {
        fg: dest,
        bg: mixedBg,
        fgExpression: 'var(--destructive)',
        bgExpression: 'color-mix(in srgb, var(--destructive) 15%, var(--card))',
        tokenNames: ['--destructive', '--card'],
      };
    },
  },
  {
    id: 'status-success-card',
    name: 'Success text on card',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-success on bg-card',
    description: 'Approved badges, additions count, passed test markers.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--success', '#22c55e'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--success)',
      bgExpression: 'var(--card)',
      tokenNames: ['--success', '--card'],
    }),
  },
  {
    id: 'status-success-pill',
    name: 'Success text on 15% tinted success pill',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-success on .bg-success/15 inside bg-card',
    description: 'Approved plan status pill, addition count badge.',
    resolve: (t) => {
      const cardBg = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const succ = resolveTokenOrFallback(t, '--success', '#22c55e');
      const mixedBg = mixColors('srgb', succ, 15, cardBg, 85);
      return {
        fg: succ,
        bg: mixedBg,
        fgExpression: 'var(--success)',
        bgExpression: 'color-mix(in srgb, var(--success) 15%, var(--card))',
        tokenNames: ['--success', '--card'],
      };
    },
  },
  {
    id: 'status-warning-card',
    name: 'Warning text on card',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-warning on bg-card',
    description: 'Modified lines count, staleness alerts on card.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--warning)',
      bgExpression: 'var(--card)',
      tokenNames: ['--warning', '--card'],
    }),
  },
  {
    id: 'status-warning-pill',
    name: 'Warning text on 15% tinted warning pill',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-warning on .bg-warning/15 inside bg-card',
    description: 'Outdated and review-warning status pills on cards.',
    resolve: (t) => {
      const card = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const warning = resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)');
      return {
        fg: warning,
        bg: mixColors('srgb', warning, 15, card, 85),
        fgExpression: 'var(--warning)',
        bgExpression: 'color-mix(in srgb, var(--warning) 15%, var(--card))',
        tokenNames: ['--warning', '--card'],
      };
    },
  },
  {
    id: 'status-warning-page-banner',
    name: 'Warning text on 10% tinted page banner',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-warning/10 .text-warning on bg-background',
    description: 'Disk-conflict and stale-PR warning banners.',
    resolve: (t) => {
      const page = resolveTokenOrFallback(t, '--background', '#000000');
      const warning = resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)');
      return {
        fg: warning,
        bg: mixColors('srgb', warning, 10, page, 90),
        fgExpression: 'var(--warning)',
        bgExpression: 'color-mix(in srgb, var(--warning) 10%, var(--background))',
        tokenNames: ['--warning', '--background'],
      };
    },
  },
  {
    id: 'status-destructive-sidebar-marker',
    name: 'Destructive text on 10% tinted sidebar marker',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-destructive/10 .text-destructive on bg-sidebar',
    description: 'File-browser save-conflict and save-error markers.',
    resolve: (t) => {
      const sidebar = resolveTokenOrFallback(t, '--sidebar', 'var(--card)');
      const destructive = resolveTokenOrFallback(t, '--destructive', '#ef4444');
      return {
        fg: destructive,
        bg: mixColors('srgb', destructive, 10, sidebar, 90),
        fgExpression: 'var(--destructive)',
        bgExpression: 'color-mix(in srgb, var(--destructive) 10%, var(--sidebar))',
        tokenNames: ['--destructive', '--sidebar'],
      };
    },
  },
  {
    id: 'status-warning-sidebar-marker',
    name: 'Warning text on 10% tinted sidebar marker',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-warning/10 .text-warning on bg-sidebar',
    description: 'File-browser missing-file marker.',
    resolve: (t) => {
      const sidebar = resolveTokenOrFallback(t, '--sidebar', 'var(--card)');
      const warning = resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)');
      return {
        fg: warning,
        bg: mixColors('srgb', warning, 10, sidebar, 90),
        fgExpression: 'var(--warning)',
        bgExpression: 'color-mix(in srgb, var(--warning) 10%, var(--sidebar))',
        tokenNames: ['--warning', '--sidebar'],
      };
    },
  },
  {
    id: 'status-success-sidebar-marker',
    name: 'Success text on 10% tinted sidebar marker',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-success/10 .text-success on bg-sidebar',
    description: 'File-browser saved marker.',
    resolve: (t) => {
      const sidebar = resolveTokenOrFallback(t, '--sidebar', 'var(--card)');
      const success = resolveTokenOrFallback(t, '--success', '#22c55e');
      return {
        fg: success,
        bg: mixColors('srgb', success, 10, sidebar, 90),
        fgExpression: 'var(--success)',
        bgExpression: 'color-mix(in srgb, var(--success) 10%, var(--sidebar))',
        tokenNames: ['--success', '--sidebar'],
      };
    },
  },
  {
    id: 'status-primary-sidebar-marker',
    name: 'Primary text on 10% tinted sidebar marker',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.bg-primary/10 .text-primary on bg-sidebar',
    description: 'File-browser saving and unsaved-edit markers.',
    resolve: (t) => {
      const sidebar = resolveTokenOrFallback(t, '--sidebar', 'var(--card)');
      const primary = resolveTokenOrFallback(t, '--primary', '#3b82f6');
      return {
        fg: primary,
        bg: mixColors('srgb', primary, 10, sidebar, 90),
        fgExpression: 'var(--primary)',
        bgExpression: 'color-mix(in srgb, var(--primary) 10%, var(--sidebar))',
        tokenNames: ['--primary', '--sidebar'],
      };
    },
  },
  {
    id: 'status-primary-card',
    name: 'Primary text on card',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-primary on bg-card',
    description: 'Interactive links, highlighted mentions, active state labels.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--primary', '#3b82f6'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--primary)',
      bgExpression: 'var(--card)',
      tokenNames: ['--primary', '--card'],
    }),
  },
  {
    id: 'status-accent-card',
    name: 'Accent text on card',
    category: 'status-text',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.text-accent on bg-card',
    description: 'Comment reference highlights, tag pills.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--accent', 'var(--primary)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--accent)',
      bgExpression: 'var(--card)',
      tokenNames: ['--accent', '--card'],
    }),
  },

  // ---------------------------------------------------------------------------
  // 5. Component Boundaries & Non-Text Contrast (SC 1.4.11 — 3.0:1)
  // ---------------------------------------------------------------------------
  {
    id: 'border-page',
    name: 'Border on page background',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.border-border on bg-background',
    description: 'Separators, sidebar boundaries, panel borders on page.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--border', '#444444'),
      bg: resolveTokenOrFallback(t, '--background', '#000000'),
      fgExpression: 'var(--border)',
      bgExpression: 'var(--background)',
      tokenNames: ['--border', '--background'],
    }),
  },
  {
    id: 'border-card',
    name: 'Border on card surface',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.border-border on bg-card',
    description: 'Dividers inside cards, table grid borders, section rules.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--border', '#444444'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--border)',
      bgExpression: 'var(--card)',
      tokenNames: ['--border', '--card'],
    }),
  },
  {
    id: 'input-border-card',
    name: 'Input border on card surface',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: 'input.border-input on bg-card',
    description: 'Text inputs, comment composer boxes, search bars.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--input', 'var(--border)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--input)',
      bgExpression: 'var(--card)',
      tokenNames: ['--input', '--card'],
    }),
  },
  {
    id: 'focus-ring-card',
    name: 'Focus ring on card surface',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: ':focus-visible ring-ring on bg-card',
    description: 'Keyboard focus indicators across interactive controls.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--ring', 'var(--primary)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--ring)',
      bgExpression: 'var(--card)',
      tokenNames: ['--ring', '--card'],
    }),
  },
  {
    id: 'focus-highlight-card',
    name: 'Focus highlight indicator on card',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.annotation-highlight.focused on bg-card',
    description: 'Vim navigation / active selected annotation border highlight.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--focus-highlight', 'var(--ring)'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--focus-highlight)',
      bgExpression: 'var(--card)',
      tokenNames: ['--focus-highlight', '--card'],
    }),
  },
  {
    id: 'switch-checked-track',
    name: 'Checked toggle switch track on card',
    category: 'component-boundary',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.vim-announcement-switch__track--checked on bg-card',
    description: 'Switch toggle track state in settings and dialogs.',
    resolve: (t) => {
      const card = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const primary = resolveTokenOrFallback(t, '--primary', '#3b82f6');
      const mixedTrack = compositeColors({ ...primary, a: 0.58 }, card);
      return {
        fg: mixedTrack,
        bg: card,
        fgExpression: 'color-mix(in srgb, var(--primary) 58%, transparent), composited once over var(--card)',
        bgExpression: 'var(--card)',
        tokenNames: ['--primary', '--card'],
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 6. Plan Diff & Annotations (SC 1.4.3 / SC 1.4.11)
  // ---------------------------------------------------------------------------
  {
    id: 'comment-annotation-mark',
    name: 'Comment annotation highlighted text mark',
    category: 'annotation',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.annotation-highlight.comment on card',
    description: 'Annotated comment highlight text in plan and document view.',
    resolve: (t) => {
      const card = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const fg = resolveTokenOrFallback(t, '--foreground', '#ffffff');
      const ctx = createTokenContext(t);
      const highlightExpr =
        t.mode === 'light'
          ? 'oklch(0.70 0.20 60 / 0.15)'
          : 'oklch(0.70 0.18 60 / 0.3)';
      const highlightColor = parseCssColor(highlightExpr, ctx)!;
      const compositedBg = compositeColors(highlightColor, card);

      return {
        fg,
        bg: compositedBg,
        fgExpression: 'var(--foreground)',
        bgExpression: `${highlightExpr} over var(--card)`,
        tokenNames: ['--foreground', '--card'],
      };
    },
  },
  {
    id: 'deletion-annotation-mark',
    name: 'Deletion annotation strike-through text mark',
    category: 'annotation',
    criterion: 'SC 1.4.3',
    targetRatio: 4.5,
    isLargeText: false,
    isNonText: false,
    source: '.annotation-highlight.deletion on card',
    description: 'Redline deleted text in plan review.',
    resolve: (t) => {
      const card = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const fg = resolveTokenOrFallback(t, '--foreground', '#ffffff');
      const highlightExpr =
        t.mode === 'light'
          ? 'oklch(0.65 0.22 25 / 0.2)'
          : 'oklch(from var(--destructive) l c h / 0.25)';
      const highlight = parseCssColor(highlightExpr, createTokenContext(t));
      if (!highlight) throw new Error(`Failed to resolve deletion highlight: ${highlightExpr}`);

      return {
        fg,
        bg: compositeColors(highlight, card),
        fgExpression: 'var(--foreground)',
        bgExpression: `${highlightExpr} over var(--card)`,
        tokenNames: ['--foreground', '--destructive', '--card'],
      };
    },
  },
  {
    id: 'diff-addition-border',
    name: 'Clean plan diff addition block left border',
    category: 'diff-state',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.plan-diff-added border on card',
    description: 'Visual indicator for added content blocks in plan clean diff.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--success', '#22c55e'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--success)',
      bgExpression: 'var(--card)',
      tokenNames: ['--success', '--card'],
    }),
  },
  {
    id: 'diff-deletion-border',
    name: 'Clean plan diff deletion block left border',
    category: 'diff-state',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.plan-diff-removed border on card',
    description: 'Visual indicator for removed content blocks in plan clean diff.',
    resolve: (t) => ({
      fg: resolveTokenOrFallback(t, '--destructive', '#ef4444'),
      bg: resolveTokenOrFallback(t, '--card', 'var(--background)'),
      fgExpression: 'var(--destructive)',
      bgExpression: 'var(--card)',
      tokenNames: ['--destructive', '--card'],
    }),
  },
  {
    id: 'diff-modified-border',
    name: 'Clean plan diff modified block left border',
    category: 'diff-state',
    criterion: 'SC 1.4.11',
    targetRatio: 3.0,
    isLargeText: false,
    isNonText: true,
    source: '.plan-diff-modified border on card',
    description: 'Visual indicator for modified content blocks in plan clean diff.',
    resolve: (t) => {
      const card = resolveTokenOrFallback(t, '--card', 'var(--background)');
      const warning = resolveTokenOrFallback(t, '--warning', 'oklch(0.75 0.15 85)');
      return {
        fg: compositeColors({ ...warning, a: 0.75 }, card),
        bg: card,
        fgExpression: 'oklch(from var(--warning) l c h / 0.75) over var(--card)',
        bgExpression: 'var(--card)',
        tokenNames: ['--warning', '--card'],
      };
    },
  },
];
