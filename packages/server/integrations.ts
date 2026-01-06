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
}

export interface BearConfig {
  plan: string;
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
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename chars
      .replace(/\s+/g, ' ')          // Normalize whitespace
      .slice(0, 50);                 // Limit length
  }
  return 'Plan';
}

/**
 * Generate human-readable filename: Title - Mon D, YYYY H-MMam.md
 * Example: User Authentication - Jan 2, 2026 2-30pm.md
 */
export function generateFilename(markdown: string): string {
  const title = extractTitle(markdown);
  const now = new Date();

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();

  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;

  return `${title} - ${month} ${day}, ${year} ${hours}-${minutes}${ampm}.md`;
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
    const filename = generateFilename(plan);
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

/**
 * Save plan to Bear using x-callback-url
 */
export async function saveToBear(config: BearConfig): Promise<IntegrationResult> {
  try {
    const { plan } = config;

    // Extract title and tags
    const title = extractTitle(plan);
    const tags = await extractTags(plan);
    const hashtags = tags.map(t => `#${t}`).join(' ');

    // Append hashtags to content
    const content = `${plan}\n\n${hashtags}`;

    // Build Bear URL
    const url = `bear://x-callback-url/create?title=${encodeURIComponent(title)}&text=${encodeURIComponent(content)}&open_note=no`;

    // Open Bear via URL scheme
    await $`open ${url}`.quiet();

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}
