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

export type DefaultDiffType = 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all';
export type DiffLineBgIntensity = 'subtle' | 'normal' | 'strong';

export interface DiffOptions {
  diffStyle?: 'split' | 'unified';
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  showLineNumbers?: boolean;
  showDiffBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  tabSize?: number;
  hideWhitespace?: boolean;
  defaultDiffType?: DefaultDiffType;
  lineBgIntensity?: DiffLineBgIntensity;
}

/** Single conventional comment label entry stored in config.json */
export interface CCLabelConfig {
  label: string;
  display: string;
  blocking: boolean;
}

export type PromptSectionOverrides = Record<string, string | undefined>;

export type PromptRuntime =
  | "claude-code"
  | "opencode"
  | "copilot-cli"
  | "pi"
  | "codex"
  | "gemini-cli";

interface PromptSectionConfig {
  [key: string]: string | Partial<Record<PromptRuntime, PromptSectionOverrides>> | undefined;
  runtimes?: Partial<Record<PromptRuntime, PromptSectionOverrides>>;
}

export interface PromptConfig {
  review?: PromptSectionConfig & {
    approved?: string;
    denied?: string;
  };
  plan?: PromptSectionConfig & {
    approved?: string;
    approvedWithNotes?: string;
    autoApproved?: string;
    denied?: string;
  };
  annotate?: PromptSectionConfig & {
    fileFeedback?: string;
    messageFeedback?: string;
    approved?: string;
  };
}

const PROMPT_SECTIONS = ["review", "plan", "annotate"] as const;

export function mergePromptConfig(
  current?: PromptConfig,
  partial?: PromptConfig,
): PromptConfig | undefined {
  if (!current && !partial) return undefined;

  const result: Record<string, any> = { ...current, ...partial };

  for (const section of PROMPT_SECTIONS) {
    const cur = current?.[section];
    const par = partial?.[section];
    if (cur || par) {
      result[section] = {
        ...cur,
        ...par,
        runtimes: (cur?.runtimes || par?.runtimes)
          ? { ...cur?.runtimes, ...par?.runtimes }
          : undefined,
      };
    }
  }

  return result as PromptConfig;
}

export interface PlannotatorConfig {
  displayName?: string;
  diffOptions?: DiffOptions;
  prompts?: PromptConfig;
  conventionalComments?: boolean;
  /** null = explicitly cleared (use defaults), undefined = not set */
  conventionalLabels?: CCLabelConfig[] | null;
  /**
   * Enable `gh attestation verify` during CLI installation/upgrade.
   * Read by scripts/install.sh|ps1|cmd on every run (not by any runtime code).
   * When true, the installer runs build-provenance verification after the
   * SHA256 checksum check; requires `gh` CLI installed and authenticated
   * (`gh auth login`). OS-level opt-in only — no UI surface. Default: false.
   */
  verifyAttestation?: boolean;
  /**
   * Enable Jina Reader for URL-to-markdown conversion during annotation.
   * When true (default), `plannotator annotate <url>` routes through
   * r.jina.ai for better JS-rendered page support and reader-mode extraction.
   * Set to false to always use plain fetch + Turndown.
   */
  jina?: boolean;
  /**
   * Inject a Plannotator Flavored Markdown reminder into every EnterPlanMode
   * call so the agent is aware it can enrich plans with code-file links,
   * callouts, tables, diagrams, task lists, and the other PFM extensions.
   * Read by the `improve-context` PreToolUse handler. Default: false.
   */
  pfmReminder?: boolean;
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
    const mergedPrompts = mergePromptConfig(current.prompts, partial.prompts);
    const merged = {
      ...current,
      ...partial,
      diffOptions: mergedDiffOptions,
      prompts: mergedPrompts,
    };
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
export function getServerConfig(gitUser: string | null): {
  displayName?: string;
  diffOptions?: DiffOptions;
  gitUser?: string;
  conventionalComments?: boolean;
  conventionalLabels?: CCLabelConfig[] | null;
} {
  const cfg = loadConfig();
  return {
    displayName: cfg.displayName,
    diffOptions: cfg.diffOptions,
    gitUser: gitUser ?? undefined,
    ...(cfg.conventionalComments !== undefined && { conventionalComments: cfg.conventionalComments }),
    ...(cfg.conventionalLabels !== undefined && { conventionalLabels: cfg.conventionalLabels }),
  };
}

/**
 * Read the user's preferred default diff type from config, falling back to 'unstaged'.
 */
export function resolveDefaultDiffType(cfg?: PlannotatorConfig): DefaultDiffType {
  const v = cfg?.diffOptions?.defaultDiffType as string | undefined;
  if (v === 'branch') return 'merge-base';
  return v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : 'unstaged';
}

/**
 * Resolve whether to use Jina Reader for URL annotation.
 *
 * Priority (highest wins):
 *   --no-jina CLI flag  →  PLANNOTATOR_JINA env var  →  config.jina  →  default true
 */
export function resolveUseJina(cliNoJina: boolean, config: PlannotatorConfig): boolean {
  // CLI flag has highest priority
  if (cliNoJina) return false;

  // Environment variable
  const envVal = process.env.PLANNOTATOR_JINA;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }

  // Config file
  if (config.jina !== undefined) return config.jina;

  // Default: enabled
  return true;
}
