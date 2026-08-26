import path from 'node:path';
import {
  BUILT_IN_THEMES,
  themesForHalf,
  type ThemeInfo,
} from '../utils/themeRegistry';
import {
  formatHex,
  getContrastRatio,
  suggestCompliantOklch,
  type RGBA,
  type OKLCH,
} from './color';
import {
  loadCssCatalog,
  resolveThemeVariantTokens,
  type CssCatalog,
  type ThemeTokens,
} from './cssParser';
import {
  SEMANTIC_INVENTORY,
  type SemanticStateDefinition,
  type SemanticCategory,
  type WcagCriterion,
} from './inventory';

export interface AuditOptions {
  themeFilter?: string; // e.g. "nord:dark", "nord", "plannotator:light"
  themesDir?: string;
  themeCssPath?: string;
  inventory?: SemanticStateDefinition[];
  repoRoot?: string;
}

export interface SemanticStateResult {
  id: string;
  name: string;
  category: SemanticCategory;
  criterion: WcagCriterion;
  targetRatio: number;
  isLargeText: boolean;
  isNonText: boolean;
  source: string;
  fgExpression: string;
  bgExpression: string;
  fgHex: string;
  bgHex: string;
  fgRgba: RGBA;
  bgRgba: RGBA;
  ratio: number;
  passed: boolean;
  aaaPassed?: boolean;
  tokenNames: string[];
  suggestion?: {
    oklch: OKLCH;
    hex: string;
    ratio: number;
  };
}

export interface ThemeVariantAudit {
  key: string; // "${themeId}:${mode}"
  themeId: string;
  themeName: string;
  mode: 'dark' | 'light';
  modeSupport: 'both' | 'dark-only' | 'light-only';
  passed: boolean;
  passedCount: number;
  failedCount: number;
  states: SemanticStateResult[];
  tokens: ThemeTokens;
}

export interface ThemeAuditReport {
  timestamp?: string;
  totalThemes: number;
  totalVariants: number;
  totalEvaluatedStates: number;
  passedStates: number;
  failedStates: number;
  complianceRate: number; // 0..100
  allPassed: boolean;
  variants: ThemeVariantAudit[];
  orphanedFiles: string[];
  missingSelectors: string[];
  diagnosticErrors: string[];
}

const REQUIRED_COLOR_TOKENS = [
  '--background', '--foreground', '--card', '--card-foreground',
  '--popover', '--popover-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring', '--success', '--success-foreground',
  '--warning', '--warning-foreground', '--code-bg',
] as const;

export function auditThemes(options: AuditOptions = {}): ThemeAuditReport {
  const root = options.repoRoot ?? path.resolve(import.meta.dir, '../../..');
  const themesDir = options.themesDir ?? path.join(root, 'packages/ui/themes');
  const themeCssPath = options.themeCssPath ?? path.join(root, 'packages/ui/theme.css');
  const inventory = options.inventory ?? SEMANTIC_INVENTORY;

  const catalog: CssCatalog = loadCssCatalog(themesDir, themeCssPath);

  // 1. Derive variants dynamically from themeRegistry
  const lightThemes: ThemeInfo[] = themesForHalf(BUILT_IN_THEMES, 'light');
  const darkThemes: ThemeInfo[] = themesForHalf(BUILT_IN_THEMES, 'dark');

  interface TargetVariant {
    themeId: string;
    themeName: string;
    mode: 'dark' | 'light';
    modeSupport: 'both' | 'dark-only' | 'light-only';
    key: string;
  }

  const targetVariants: TargetVariant[] = [];
  const variantKeys = new Set<string>();

  for (const t of darkThemes) {
    const key = `${t.id}:dark`;
    if (variantKeys.has(key)) {
      throw new Error(`Duplicate variant key derived: ${key}`);
    }
    variantKeys.add(key);
    targetVariants.push({
      themeId: t.id,
      themeName: t.name,
      mode: 'dark',
      modeSupport: t.modeSupport,
      key,
    });
  }

  for (const t of lightThemes) {
    const key = `${t.id}:light`;
    if (variantKeys.has(key)) {
      throw new Error(`Duplicate variant key derived: ${key}`);
    }
    variantKeys.add(key);
    targetVariants.push({
      themeId: t.id,
      themeName: t.name,
      mode: 'light',
      modeSupport: t.modeSupport,
      key,
    });
  }

  // 2. Validate registry vs CSS files integrity
  const registeredIds = new Set(BUILT_IN_THEMES.map((t) => t.id));
  const cssThemeIds = new Set(catalog.themes.keys());

  const orphanedFiles: string[] = [];
  for (const file of catalog.allFiles) {
    const id = file.replace(/\.css$/, '');
    if (!registeredIds.has(id)) {
      orphanedFiles.push(file);
    }
  }

  const missingSelectors: string[] = [];
  const diagnosticErrors: string[] = [];
  for (const theme of BUILT_IN_THEMES) {
    const parsed = catalog.themes.get(theme.id);
    if (!parsed) {
      missingSelectors.push(`Missing stylesheet: ${theme.id}.css`);
      continue;
    }
    if (!catalog.importedThemeIds.has(theme.id)) {
      missingSelectors.push(`Stylesheet not imported by theme.css: ${theme.id}.css`);
    }
    if (!parsed.hasDarkSelector) {
      missingSelectors.push(`Missing exact selector: .theme-${theme.id}`);
    }
    if (theme.modeSupport !== 'dark-only' && !parsed.hasExplicitLightSelector) {
      missingSelectors.push(`Missing exact light selector: .theme-${theme.id}.light`);
    }
  }
  for (const importedId of catalog.importedThemeIds) {
    if (!registeredIds.has(importedId)) diagnosticErrors.push(`Orphan theme.css import: ${importedId}.css`);
    if (!cssThemeIds.has(importedId)) diagnosticErrors.push(`Imported stylesheet missing on disk: ${importedId}.css`);
  }

  // Filter if option supplied
  let variantsToAudit = targetVariants;
  if (options.themeFilter) {
    const filter = options.themeFilter.trim();
    if (filter.includes(':')) {
      variantsToAudit = targetVariants.filter((v) => v.key === filter);
    } else {
      variantsToAudit = targetVariants.filter((v) => v.themeId === filter);
    }
    if (variantsToAudit.length === 0) {
      diagnosticErrors.push(`No theme variants matched filter: "${options.themeFilter}"`);
    }
  }

  // 3. Execute audit for each variant
  const variantAudits: ThemeVariantAudit[] = [];
  let totalEvaluatedStates = 0;
  let passedStates = 0;
  let failedStates = 0;

  for (const variant of variantsToAudit) {
    let tokens: ThemeTokens;
    try {
      tokens = resolveThemeVariantTokens(catalog, variant.themeId, variant.mode);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnosticErrors.push(`Failed to resolve tokens for ${variant.key}: ${msg}`);
      continue;
    }

    for (const token of REQUIRED_COLOR_TOKENS) {
      if (!tokens.rawTokens[token]) {
        diagnosticErrors.push(`Missing required token '${token}' on variant '${variant.key}'`);
      } else if (!tokens.resolvedColors[token]) {
        diagnosticErrors.push(`Unresolvable required color '${token}' on variant '${variant.key}': ${tokens.rawTokens[token]}`);
      }
    }

    const stateResults: SemanticStateResult[] = [];
    let variantPassedCount = 0;
    let variantFailedCount = 0;

    for (const stateDef of inventory) {
      try {
        const { fg, bg, fgExpression, bgExpression, tokenNames } = stateDef.resolve(tokens);
        const ratio = getContrastRatio(fg, bg);
        const roundedRatio = Math.round(ratio * 100) / 100;
        const passed = ratio >= stateDef.targetRatio;

        const aaaThreshold = stateDef.isLargeText ? 4.5 : 7.0;
        const aaaPassed = stateDef.isNonText ? undefined : ratio >= aaaThreshold;

        let suggestion: { oklch: OKLCH; hex: string; ratio: number } | undefined;
        if (!passed) {
          suggestion = suggestCompliantOklch(fg, bg, stateDef.targetRatio, variant.mode);
        }

        if (passed) {
          variantPassedCount++;
          passedStates++;
        } else {
          variantFailedCount++;
          failedStates++;
        }
        totalEvaluatedStates++;

        stateResults.push({
          id: stateDef.id,
          name: stateDef.name,
          category: stateDef.category,
          criterion: stateDef.criterion,
          targetRatio: stateDef.targetRatio,
          isLargeText: stateDef.isLargeText,
          isNonText: stateDef.isNonText,
          source: stateDef.source,
          fgExpression,
          bgExpression,
          fgHex: formatHex(fg),
          bgHex: formatHex(bg),
          fgRgba: fg,
          bgRgba: bg,
          ratio: roundedRatio,
          passed,
          aaaPassed,
          tokenNames,
          suggestion,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnosticErrors.push(
          `Error evaluating state '${stateDef.id}' on variant '${variant.key}': ${msg}`
        );
        variantFailedCount++;
        failedStates++;
        totalEvaluatedStates++;
      }
    }

    variantAudits.push({
      key: variant.key,
      themeId: variant.themeId,
      themeName: variant.themeName,
      mode: variant.mode,
      modeSupport: variant.modeSupport,
      passed: variantFailedCount === 0 && stateResults.length === inventory.length,
      passedCount: variantPassedCount,
      failedCount: variantFailedCount,
      states: stateResults,
      tokens,
    });
  }

  const complianceRate =
    totalEvaluatedStates > 0
      ? Math.round((passedStates / totalEvaluatedStates) * 10000) / 100
      : 0;

  return {
    totalThemes: new Set(variantsToAudit.map((variant) => variant.themeId)).size,
    totalVariants: variantsToAudit.length,
    totalEvaluatedStates,
    passedStates,
    failedStates,
    complianceRate,
    allPassed:
      failedStates === 0 &&
      diagnosticErrors.length === 0 &&
      orphanedFiles.length === 0 &&
      missingSelectors.length === 0 &&
      variantAudits.length === variantsToAudit.length &&
      variantAudits.every((variant) => variant.passed),
    variants: variantAudits,
    orphanedFiles,
    missingSelectors,
    diagnosticErrors,
  };
}
