import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-obsidian-enabled';
const STORAGE_KEY_VAULT = 'plannotator-obsidian-vault';
const STORAGE_KEY_FOLDER = 'plannotator-obsidian-folder';
const STORAGE_KEY_CUSTOM_PATH = 'plannotator-obsidian-custom-path';
const STORAGE_KEY_FILENAME_FORMAT = 'plannotator-obsidian-filename-format';
const STORAGE_KEY_VAULT_BROWSER = 'plannotator-obsidian-vault-browser';
const STORAGE_KEY_AUTOSAVE = 'plannotator-obsidian-autosave';
const STORAGE_KEY_FILENAME_SEPARATOR = 'plannotator-obsidian-filename-separator';

export const CUSTOM_PATH_SENTINEL = '__custom__';

const DEFAULT_FOLDER = 'plannotator';

export const DEFAULT_FILENAME_FORMAT = '{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}';

export type FilenameSeparator = 'space' | 'dash' | 'underscore';

export interface ObsidianSettings {
  enabled: boolean;
  vaultPath: string;      // Selected vault path OR '__custom__' sentinel
  folder: string;
  customPath?: string;    // User-entered path when vaultPath === '__custom__'
  filenameFormat?: string; // Custom filename format (e.g. '{YYYY}-{MM}-{DD} - {title}')
  filenameSeparator: FilenameSeparator; // Replace spaces in filename with dash/underscore
  autoSave: boolean;      // Auto-save to Obsidian on plan arrival
  vaultBrowserEnabled: boolean; // Show vault file browser in sidebar
}

export function getObsidianSettings(): ObsidianSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    vaultPath: storage.getItem(STORAGE_KEY_VAULT) || '',
    folder: storage.getItem(STORAGE_KEY_FOLDER) || DEFAULT_FOLDER,
    customPath: storage.getItem(STORAGE_KEY_CUSTOM_PATH) || undefined,
    filenameFormat: storage.getItem(STORAGE_KEY_FILENAME_FORMAT) || undefined,
    filenameSeparator: (storage.getItem(STORAGE_KEY_FILENAME_SEPARATOR) as FilenameSeparator) || 'space',
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
    vaultBrowserEnabled: storage.getItem(STORAGE_KEY_VAULT_BROWSER) === 'true',
  };
}

export function saveObsidianSettings(settings: ObsidianSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_VAULT, settings.vaultPath);
  storage.setItem(STORAGE_KEY_FOLDER, settings.folder);
  storage.setItem(STORAGE_KEY_CUSTOM_PATH, settings.customPath || '');
  storage.setItem(STORAGE_KEY_FILENAME_FORMAT, settings.filenameFormat || '');
  storage.setItem(STORAGE_KEY_FILENAME_SEPARATOR, settings.filenameSeparator || 'space');
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
  storage.setItem(STORAGE_KEY_VAULT_BROWSER, String(settings.vaultBrowserEnabled));
}

export function getEffectiveVaultPath(settings: ObsidianSettings): string {
  if (settings.vaultPath === CUSTOM_PATH_SENTINEL) {
    return settings.customPath || '';
  }
  return settings.vaultPath;
}

export function isObsidianConfigured(): boolean {
  const settings = getObsidianSettings();
  const effectivePath = getEffectiveVaultPath(settings);
  return settings.enabled && effectivePath.trim().length > 0;
}

/** Check if the vault browser sidebar tab should be shown */
export function isVaultBrowserEnabled(): boolean {
  const settings = getObsidianSettings();
  const effectivePath = getEffectiveVaultPath(settings);
  return settings.enabled && settings.vaultBrowserEnabled && effectivePath.trim().length > 0;
}

/**
 * Extract tags from markdown content using simple heuristics Extracts: - Words from the first H1
 * title (excluding common words) - Code fence languages (```typescript.
 */
export function extractTags(markdown: string): string[] {
  const tags = new Set<string>(['plannotator']);

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into',
    'plan', 'implementation', 'overview', 'phase', 'step', 'steps',
  ]);

  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    const titleWords = h1Match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')  // Remove special chars except hyphens
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    titleWords.slice(0, 3).forEach(word => tags.add(word));
  }

  const langMatches = markdown.matchAll(/```(\w+)/g);
  const seenLangs = new Set<string>();

  for (const [, lang] of langMatches) {
    const normalizedLang = lang.toLowerCase();
    if (!seenLangs.has(normalizedLang) &&
        !['json', 'yaml', 'yml', 'text', 'txt', 'markdown', 'md'].includes(normalizedLang)) {
      seenLangs.add(normalizedLang);
      tags.add(normalizedLang);
    }
  }

  return Array.from(tags).slice(0, 6);
}

export function generateFrontmatter(tags: string[]): string {
  const now = new Date().toISOString();
  const tagList = tags.map(t => t.toLowerCase()).join(', ');

  return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

export function generateFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .slice(0, 16)           // "2026-01-02T14:30"
    .replace('T', '-')      // "2026-01-02-14:30"
    .replace(/:/g, '');     // "2026-01-02-1430"

  return `${timestamp}.md`;
}

export function prepareNoteContent(markdown: string): string {
  const tags = extractTags(markdown);
  const frontmatter = generateFrontmatter(tags);

  return `${frontmatter}\n\n${markdown}`;
}
