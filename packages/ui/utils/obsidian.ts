/**
 * Obsidian Integration Utility
 *
 * Manages settings for auto-saving plans to Obsidian vaults.
 * Settings are stored in cookies (like other settings) so they persist
 * across different ports used by the hook server.
 */

import { storage } from './storage';

// Storage keys
const STORAGE_KEY_ENABLED = 'plannotator-obsidian-enabled';
const STORAGE_KEY_VAULT = 'plannotator-obsidian-vault';
const STORAGE_KEY_FOLDER = 'plannotator-obsidian-folder';

// Default folder name in the vault
const DEFAULT_FOLDER = 'plannotator';

/**
 * Obsidian integration settings
 */
export interface ObsidianSettings {
  enabled: boolean;
  vaultPath: string;
  folder: string;
}

/**
 * Get current Obsidian settings from storage
 */
export function getObsidianSettings(): ObsidianSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    vaultPath: storage.getItem(STORAGE_KEY_VAULT) || '',
    folder: storage.getItem(STORAGE_KEY_FOLDER) || DEFAULT_FOLDER,
  };
}

/**
 * Save Obsidian settings to storage
 */
export function saveObsidianSettings(settings: ObsidianSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_VAULT, settings.vaultPath);
  storage.setItem(STORAGE_KEY_FOLDER, settings.folder);
}

/**
 * Check if Obsidian integration is properly configured
 */
export function isObsidianConfigured(): boolean {
  const settings = getObsidianSettings();
  return settings.enabled && settings.vaultPath.trim().length > 0;
}

/**
 * Extract tags from markdown content using simple heuristics
 *
 * Extracts:
 * - Words from the first H1 title (excluding common words)
 * - Code fence languages (```typescript, ```sql, etc.)
 * - Always includes "plan" as base tag
 *
 * @param markdown - The markdown content to extract tags from
 * @returns Array of lowercase tag strings (max 6)
 */
export function extractTags(markdown: string): string[] {
  const tags = new Set<string>(['plan']);

  // Common words to exclude from title extraction
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into',
    'plan', 'implementation', 'overview', 'phase', 'step', 'steps',
  ]);

  // 1. Extract from first H1 title
  // Matches: "# Title" or "# Implementation Plan: Title" or "# Plan: Title"
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    const titleWords = h1Match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')  // Remove special chars except hyphens
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    // Add first 3 meaningful words from title
    titleWords.slice(0, 3).forEach(word => tags.add(word));
  }

  // 2. Extract code fence languages
  // Matches: ```typescript, ```sql, ```rust, etc.
  const langMatches = markdown.matchAll(/```(\w+)/g);
  const seenLangs = new Set<string>();

  for (const [, lang] of langMatches) {
    const normalizedLang = lang.toLowerCase();
    // Skip generic/config languages and duplicates
    if (!seenLangs.has(normalizedLang) &&
        !['json', 'yaml', 'yml', 'text', 'txt', 'markdown', 'md'].includes(normalizedLang)) {
      seenLangs.add(normalizedLang);
      tags.add(normalizedLang);
    }
  }

  // Return max 6 tags
  return Array.from(tags).slice(0, 6);
}

/**
 * Generate YAML frontmatter for an Obsidian note
 *
 * @param tags - Array of tags to include
 * @returns Frontmatter string including opening and closing ---
 */
export function generateFrontmatter(tags: string[]): string {
  const now = new Date().toISOString();
  const tagList = tags.map(t => t.toLowerCase()).join(', ');

  return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

/**
 * Generate a filename for the plan note
 * Format: YYYY-MM-DD-HHmm.md (e.g., 2026-01-02-1430.md)
 *
 * @returns Filename string
 */
export function generateFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .slice(0, 16)           // "2026-01-02T14:30"
    .replace('T', '-')      // "2026-01-02-14:30"
    .replace(/:/g, '');     // "2026-01-02-1430"

  return `${timestamp}.md`;
}

/**
 * Prepare the full note content with frontmatter
 *
 * @param markdown - The plan markdown content
 * @returns Full note content with frontmatter prepended
 */
export function prepareNoteContent(markdown: string): string {
  const tags = extractTags(markdown);
  const frontmatter = generateFrontmatter(tags);

  return `${frontmatter}\n\n${markdown}`;
}
