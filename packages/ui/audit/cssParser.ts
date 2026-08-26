import fs from 'node:fs';
import path from 'node:path';
import { parseCssColor, type RGBA, type ColorResolutionContext } from './color';

export interface ThemeTokens {
  themeId: string;
  mode: 'dark' | 'light';
  rawTokens: Record<string, string>;
  resolvedColors: Record<string, RGBA>;
}

export interface ParsedThemeFile {
  filename: string;
  filePath: string;
  themeId: string;
  darkTokens: Record<string, string>;
  lightTokens: Record<string, string>;
  hasDarkSelector: boolean;
  hasExplicitLightSelector: boolean;
  selectors: string[];
}

export interface CssCatalog {
  rootTokens: Record<string, string>;
  themes: Map<string, ParsedThemeFile>;
  allFiles: string[];
  importedThemeIds: Set<string>;
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function parseCssDeclarations(blockBody: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  const cleaned = stripCssComments(blockBody);
  for (const statement of cleaned.split(';')) {
    const colonIndex = statement.indexOf(':');
    if (colonIndex === -1) continue;
    const property = statement.slice(0, colonIndex).trim();
    const value = statement.slice(colonIndex + 1).trim();
    if (property.startsWith('--') && value) declarations[property] = value;
  }
  return declarations;
}

export function parseThemeStylesheet(filePath: string): ParsedThemeFile {
  const filename = path.basename(filePath);
  const themeId = filename.replace(/\.css$/, '');
  const content = stripCssComments(fs.readFileSync(filePath, 'utf8'));
  const darkTokens: Record<string, string> = {};
  const lightTokens: Record<string, string> = {};
  const selectors: string[] = [];
  const darkSelector = `.theme-${themeId}`;
  const lightSelector = `${darkSelector}.light`;
  let hasDarkSelector = false;
  let hasExplicitLightSelector = false;
  const ruleRegex = /([^{]+)\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(content)) !== null) {
    const declarations = parseCssDeclarations(match[2]);
    const ruleSelectors = match[1].split(',').map((selector) => selector.trim());
    selectors.push(...ruleSelectors);
    for (const selector of ruleSelectors) {
      if (selector === lightSelector || selector === `.light${darkSelector}`) {
        hasExplicitLightSelector = true;
        Object.assign(lightTokens, declarations);
      } else if (selector === darkSelector) {
        hasDarkSelector = true;
        Object.assign(darkTokens, declarations);
      }
    }
  }

  return {
    filename,
    filePath,
    themeId,
    darkTokens,
    lightTokens,
    hasDarkSelector,
    hasExplicitLightSelector,
    selectors,
  };
}

export function parseThemeCss(themeCssPath: string): Record<string, string> {
  const content = stripCssComments(fs.readFileSync(themeCssPath, 'utf8'));
  const rootTokens: Record<string, string> = {};
  let searchPosition = 0;

  while (true) {
    const rootIndex = content.indexOf(':root', searchPosition);
    if (rootIndex === -1) break;
    const openBrace = content.indexOf('{', rootIndex);
    if (openBrace === -1) break;
    let depth = 1;
    let closeBrace = openBrace + 1;
    for (let index = openBrace + 1; index < content.length; index++) {
      if (content[index] === '{') depth++;
      else if (content[index] === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = index;
          break;
        }
      }
    }
    Object.assign(rootTokens, parseCssDeclarations(content.slice(openBrace + 1, closeBrace)));
    searchPosition = closeBrace + 1;
  }

  return rootTokens;
}

export function loadCssCatalog(themesDir: string, themeCssPath: string): CssCatalog {
  const rootTokens = parseThemeCss(themeCssPath);
  const themes = new Map<string, ParsedThemeFile>();
  const allFiles: string[] = [];
  const importedThemeIds = new Set<string>();
  const themeCss = fs.readFileSync(themeCssPath, 'utf8');
  for (const match of themeCss.matchAll(/@import\s+["']\.\/themes\/([^"']+)\.css["']/g)) {
    importedThemeIds.add(match[1]);
  }

  for (const entry of fs.readdirSync(themesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue;
    allFiles.push(entry.name);
    const parsed = parseThemeStylesheet(path.join(themesDir, entry.name));
    if (themes.has(parsed.themeId)) throw new Error(`Duplicate theme stylesheet id: ${parsed.themeId}`);
    themes.set(parsed.themeId, parsed);
  }

  return { rootTokens, themes, allFiles, importedThemeIds };
}

export function resolveThemeVariantTokens(
  catalog: CssCatalog,
  themeId: string,
  mode: 'dark' | 'light'
): ThemeTokens {
  const theme = catalog.themes.get(themeId);
  if (!theme) throw new Error(`Theme '${themeId}' not found in CSS catalog.`);
  const rawTokens: Record<string, string> = { ...catalog.rootTokens, ...theme.darkTokens };
  if (mode === 'light') Object.assign(rawTokens, theme.lightTokens);
  const context: ColorResolutionContext = { resolveVar: (name) => rawTokens[name] };
  const resolvedColors: Record<string, RGBA> = {};

  for (const [property, value] of Object.entries(rawTokens)) {
    const parsed = parseCssColor(value, context);
    if (parsed) resolvedColors[property] = parsed;
  }

  return { themeId, mode, rawTokens, resolvedColors };
}
