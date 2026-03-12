/**
 * Note-taking app integrations (Obsidian, Bear)
 */

import { $ } from "bun";
import { join } from "path";
import { mkdirSync, existsSync, statSync, readFileSync } from "fs";
import { detectProjectName } from "./project";

// --- Types ---

export interface ObsidianConfig {
  vaultPath: string;
  folder: string;
  plan: string;
  filenameFormat?: string; // Custom format string, e.g. '{YYYY}-{MM}-{DD} - {title}'
  filenameSeparator?: 'space' | 'dash' | 'underscore'; // Replace spaces in filename
}

export interface BearConfig {
  plan: string;
  customTags?: string;
  tagPosition?: 'prepend' | 'append';
}

export interface IntegrationResult {
  success: boolean;
  error?: string;
  path?: string;
}

// --- Tag Extraction ---

/**
 * Extract tags from markdown content using simple heuristics
 * Includes project name detection (git repo or directory name)
 */
export async function extractTags(markdown: string): Promise<string[]> {
  const tags = new Set<string>(["plannotator"]);

  // Add project name tag (git repo name or directory fallback)
  const projectName = await detectProjectName();
  if (projectName) {
    tags.add(projectName);
  }

  const stopWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "into",
    "plan", "implementation", "overview", "phase", "step", "steps",
  ]);

  // Extract from first H1 title
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    const titleWords = h1Match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));
    titleWords.slice(0, 3).forEach((word) => tags.add(word));
  }

  // Extract code fence languages
  const langMatches = markdown.matchAll(/```(\w+)/g);
  const seenLangs = new Set<string>();
  for (const [, lang] of langMatches) {
    const normalizedLang = lang.toLowerCase();
    if (
      !seenLangs.has(normalizedLang) &&
      !["json", "yaml", "yml", "text", "txt", "markdown", "md"].includes(normalizedLang)
    ) {
      seenLangs.add(normalizedLang);
      tags.add(normalizedLang);
    }
  }

  return Array.from(tags).slice(0, 7);
}

// --- Frontmatter and Filename Generation ---

/**
 * Generate frontmatter for the note
 */
export function generateFrontmatter(tags: string[]): string {
  const now = new Date().toISOString();
  const tagList = tags.map((t) => t.toLowerCase()).join(", ");
  return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

/**
 * Extract title from markdown (first H1 heading)
 */
export function extractTitle(markdown: string): string {
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    // Clean up the title for use as filename
    return h1Match[1]
      .trim()
      .replace(/[<>:"/\\|?*(){}\[\]#~`]/g, '') // Remove invalid/problematic filename chars
      .replace(/\s+/g, ' ')          // Normalize whitespace
      .trim()                         // Re-trim after stripping
      .slice(0, 50);                 // Limit length
  }
  return 'Plan';
}

/** Default filename format matching original behavior */
export const DEFAULT_FILENAME_FORMAT = '{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}';

/**
 * Generate filename from a format string with variable substitution.
 *
 * Supported variables:
 *   {title}  - Plan title from first H1 heading
 *   {YYYY}   - 4-digit year
 *   {MM}     - 2-digit month (01-12)
 *   {DD}     - 2-digit day (01-31)
 *   {Mon}    - Abbreviated month name (Jan, Feb, ...)
 *   {D}      - Day without leading zero
 *   {HH}     - 2-digit hour, 24h (00-23)
 *   {h}      - Hour without leading zero, 12h
 *   {hh}     - 2-digit hour, 12h (01-12)
 *   {mm}     - 2-digit minutes (00-59)
 *   {ss}     - 2-digit seconds (00-59)
 *   {ampm}   - am/pm
 *
 * Default format: '{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}'
 * Example output: 'User Authentication - Jan 2, 2026 2-30pm.md'
 */
export function generateFilename(markdown: string, format?: string, separator?: 'space' | 'dash' | 'underscore'): string {
  const title = extractTitle(markdown);
  const now = new Date();

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const hour24 = now.getHours();
  const hour12 = hour24 % 12 || 12;
  const ampm = hour24 >= 12 ? 'pm' : 'am';

  const vars: Record<string, string> = {
    title,
    YYYY: String(now.getFullYear()),
    MM:   String(now.getMonth() + 1).padStart(2, '0'),
    DD:   String(now.getDate()).padStart(2, '0'),
    Mon:  months[now.getMonth()],
    D:    String(now.getDate()),
    HH:   String(hour24).padStart(2, '0'),
    h:    String(hour12),
    hh:   String(hour12).padStart(2, '0'),
    mm:   String(now.getMinutes()).padStart(2, '0'),
    ss:   String(now.getSeconds()).padStart(2, '0'),
    ampm,
  };

  const template = format?.trim() || DEFAULT_FILENAME_FORMAT;
  const result = template.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);

  // Sanitize: remove characters invalid in filenames
  let sanitized = result.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();

  // Apply separator preference (replace spaces with dash or underscore)
  if (separator === 'dash') {
    sanitized = sanitized.replace(/ /g, '-');
  } else if (separator === 'underscore') {
    sanitized = sanitized.replace(/ /g, '_');
  }

  return sanitized.endsWith('.md') ? sanitized : `${sanitized}.md`;
}

// --- Obsidian Integration ---

/**
 * Detect Obsidian vaults by reading Obsidian's config file
 * Returns array of vault paths found on the system
 */
export function detectObsidianVaults(): string[] {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    let configPath: string;

    // Platform-specific config locations
    if (process.platform === "darwin") {
      configPath = join(home, "Library/Application Support/obsidian/obsidian.json");
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA || join(home, "AppData/Roaming");
      configPath = join(appData, "obsidian/obsidian.json");
    } else {
      // Linux
      configPath = join(home, ".config/obsidian/obsidian.json");
    }

    if (!existsSync(configPath)) {
      return [];
    }

    const configContent = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);

    if (!config.vaults || typeof config.vaults !== "object") {
      return [];
    }

    // Extract vault paths, filter to ones that exist
    const vaults: string[] = [];
    for (const vaultId of Object.keys(config.vaults)) {
      const vault = config.vaults[vaultId];
      if (vault.path && existsSync(vault.path)) {
        vaults.push(vault.path);
      }
    }

    return vaults;
  } catch {
    return [];
  }
}

/**
 * Save plan to Obsidian vault with cross-platform path handling
 */
export async function saveToObsidian(config: ObsidianConfig): Promise<IntegrationResult> {
  try {
    const { vaultPath, folder, plan } = config;

    // Normalize path (handle ~ on Unix, forward/back slashes)
    let normalizedVault = vaultPath.trim();

    // Expand ~ to home directory (Unix/macOS)
    if (normalizedVault.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      normalizedVault = join(home, normalizedVault.slice(1));
    }

    // Validate vault path exists and is a directory
    if (!existsSync(normalizedVault)) {
      return { success: false, error: `Vault path does not exist: ${normalizedVault}` };
    }

    const vaultStat = statSync(normalizedVault);
    if (!vaultStat.isDirectory()) {
      return { success: false, error: `Vault path is not a directory: ${normalizedVault}` };
    }

    // Build target folder path
    const folderName = folder.trim() || "plannotator";
    const targetFolder = join(normalizedVault, folderName);

    // Create folder if it doesn't exist
    mkdirSync(targetFolder, { recursive: true });

    // Generate filename and full path
    const filename = generateFilename(plan, config.filenameFormat, config.filenameSeparator);
    const filePath = join(targetFolder, filename);

    // Generate content with frontmatter and backlink
    const tags = await extractTags(plan);
    const frontmatter = generateFrontmatter(tags);
    const content = `${frontmatter}\n\n[[Plannotator Plans]]\n\n${plan}`;

    // Write file
    await Bun.write(filePath, content);

    return { success: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}

// --- Bear Integration ---

export function stripH1(plan: string): string {
  return plan.replace(/^#\s+.+\n?/m, '').trimStart();
}

export function buildHashtags(customTags: string | undefined, autoTags: string[]): string {
  if (customTags?.trim()) {
    return customTags.split(',').map(t => `#${t.trim()}`).filter(t => t !== '#').join(' ');
  }
  return autoTags.map(t => `#${t}`).join(' ');
}

export function buildBearContent(body: string, hashtags: string, tagPosition: 'prepend' | 'append'): string {
  return tagPosition === 'prepend'
    ? `${hashtags}\n\n${body}`
    : `${body}\n\n${hashtags}`;
}

/**
 * Save plan to Bear using x-callback-url
 */
export async function saveToBear(config: BearConfig): Promise<IntegrationResult> {
  try {
    const { plan, customTags, tagPosition = 'append' } = config;

    const title = extractTitle(plan);
    const body = stripH1(plan);

    const tags = customTags?.trim()
      ? undefined
      : await extractTags(plan);
    const hashtags = buildHashtags(customTags, tags ?? []);

    const content = buildBearContent(body, hashtags, tagPosition);

    const url = `bear://x-callback-url/create?title=${encodeURIComponent(title)}&text=${encodeURIComponent(content)}&open_note=no`;

    await $`open ${url}`.quiet();

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}
