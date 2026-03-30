/**
 * Plannotator Config
 *
 * Reads/writes ~/.plannotator/config.json for persistent user settings.
 * Runtime-agnostic: uses only node:fs, node:os, node:child_process.
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

export interface DiffOptions {
  diffStyle?: 'split' | 'unified';
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  showLineNumbers?: boolean;
  showDiffBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
}

export interface PlannotatorConfig {
  displayName?: string;
  diffOptions?: DiffOptions;
}

const CONFIG_DIR = join(homedir(), ".plannotator");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Load config from ~/.plannotator/config.json.
 * Returns {} on missing file or malformed JSON.
 */
export function loadConfig(): PlannotatorConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    process.stderr.write(`[plannotator] Warning: failed to read config.json: ${e}\n`);
    return {};
  }
}

/**
 * Save config by merging partial values into the existing file.
 * Creates ~/.plannotator/ directory if needed.
 */
export function saveConfig(partial: Partial<PlannotatorConfig>): void {
  try {
    const current = loadConfig();
    const mergedDiffOptions = (current.diffOptions || partial.diffOptions)
      ? { ...current.diffOptions, ...partial.diffOptions }
      : undefined;
    const merged = { ...current, ...partial, diffOptions: mergedDiffOptions };
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch (e) {
    process.stderr.write(`[plannotator] Warning: failed to write config.json: ${e}\n`);
  }
}

/**
 * Detect the git user name from `git config user.name`.
 * Returns null if git is unavailable, not in a repo, or user.name is not set.
 */
export function detectGitUser(): string | null {
  try {
    const name = execSync("git config user.name", { encoding: "utf-8", timeout: 3000 }).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Build the serverConfig payload for API responses.
 * Reads config.json fresh each call so the response reflects the latest file on disk.
 */
export function getServerConfig(gitUser: string | null): { displayName?: string; diffOptions?: DiffOptions; gitUser?: string } {
  const cfg = loadConfig();
  return { displayName: cfg.displayName, diffOptions: cfg.diffOptions, gitUser: gitUser ?? undefined };
}
