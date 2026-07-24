/**
 * Plannotator Config
 *
 * Reads/writes ~/.plannotator/config.json for persistent user settings.
 * Runtime-agnostic: uses only node:fs, node:os, node:child_process.
 */

import { join } from "path";
import { getPlannotatorDataDir } from "./data-dir";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

import type { DefaultDiffType, DiffLineBgIntensity, DiffOptions } from '@plannotator/core/config-types';
export type { DefaultDiffType, DiffLineBgIntensity, DiffOptions };

/** Single conventional comment label entry stored in config.json */
export interface CCLabelConfig {
  label: string;
  display: string;
  blocking: boolean;
}

export type PromptSectionOverrides = Record<string, string | undefined>;

export type PromptRuntime =
  | "claude-code"
  | "amp"
  | "droid"
  | "kiro-cli"
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
   * Save per-file version history when annotating local files. Powers the
   * annotate version diff ("what changed since I last looked"). NOTE: this
   * writes a copy of each annotated file's content under
   * ~/.plannotator/history/ (or PLANNOTATOR_DATA_DIR). Set to false to keep
   * annotate sessions fully stateless. Default: true.
   */
  annotateHistory?: boolean;
  /**
   * Persist successful Guided Reviews (guide content + per-section reviewed
   * state) under ~/.plannotator/guides/ (or PLANNOTATOR_DATA_DIR) so they
   * survive closing Plannotator. Set to false to disable writes; already-saved
   * guides remain readable and listed. Default: true.
   */
  guideHistory?: boolean;
  /**
   * Inject a Plannotator Flavored Markdown reminder into every EnterPlanMode
   * call so the agent is aware it can enrich plans with code-file links,
   * callouts, tables, diagrams, task lists, and the other PFM extensions.
   * Read by the `improve-context` PreToolUse handler. Default: false.
   */
  pfmReminder?: boolean;
  /**
   * Open Plannotator in a Glimpse native window when available.
   * When true (default), the server spawns `glimpseui` if it is on PATH,
   * no explicit browser is configured, and the session is local.
   * Set to false to always use the system browser even when Glimpse is installed.
   */
  glimpse?: boolean;
  /**
   * Control URL sharing (Share tab, copy link, short URLs, import review).
   * Defaults to enabled. Set to "disabled" to hide all sharing UI — useful
   * for teams working with sensitive plans. Mirrors the PLANNOTATOR_SHARE
   * env var value, which takes precedence over this setting.
   */
  share?: "enabled" | "disabled";
  /**
   * Pass `--sandbox enabled` when launching Cursor's `agent` CLI for review
   * jobs. When true (default), review jobs run with Cursor's sandbox forced
   * on as part of their read-only posture. Set to false on systems where
   * Cursor's sandbox cannot start (e.g. NixOS / AppArmor-restricted Linux):
   * the flag pair is then OMITTED entirely, deferring to the user's own
   * Cursor Agent sandbox configuration. Mirrors the
   * PLANNOTATOR_CURSOR_SANDBOX env var, which takes precedence.
   */
  cursorSandbox?: boolean;
}

const CONFIG_DIR = getPlannotatorDataDir();
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
 * Read the user's preferred default diff type from config, falling back to
 * 'since-base' (the composite "what would GitHub show" view). Users with an
 * explicit defaultDiffType keep their choice.
 */
export function resolveDefaultDiffType(cfg?: PlannotatorConfig): DefaultDiffType {
  const v = cfg?.diffOptions?.defaultDiffType as string | undefined;
  if (v === 'branch') return 'merge-base';
  return v === 'since-base' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : 'since-base';
}

/**
 * Coerce a config.json value that should be a boolean. JSON parsing preserves
 * whatever type the user typed, so a hand-edited `"false"` (quoted) arrives as
 * a string and would fail `=== false` checks downstream. Accepts real booleans
 * plus "true"/"false"/"1"/"0" strings; anything else falls back to the default.
 */
function coerceConfigBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return fallback;
}

/**
 * Resolve whether to use Glimpse native window.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_GLIMPSE env var  →  config.glimpse  →  default true
 */
export function resolveUseGlimpse(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_GLIMPSE;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }
  return coerceConfigBoolean(config.glimpse, true);
}

/**
 * Resolve whether to use Jina Reader for URL annotation.
 *
 * Priority (highest wins):
 *   --no-jina CLI flag  →  PLANNOTATOR_JINA env var  →  config.jina  →  default true
 */
/**
 * Resolve whether annotate mode saves per-file version history.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_ANNOTATE_HISTORY env var  →  config.annotateHistory  →  default true
 */
export function resolveAnnotateHistory(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }
  return coerceConfigBoolean(config.annotateHistory, true);
}

/**
 * Resolve whether successful Guided Reviews are persisted to disk.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_GUIDE_HISTORY env var  →  config.guideHistory  →  default true
 */
export function resolveGuideHistory(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_GUIDE_HISTORY;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }
  return coerceConfigBoolean(config.guideHistory, true);
}

export function resolveUseJina(cliNoJina: boolean, config: PlannotatorConfig): boolean {
  // CLI flag has highest priority
  if (cliNoJina) return false;

  // Environment variable
  const envVal = process.env.PLANNOTATOR_JINA;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }

  // Config file (default: enabled)
  return coerceConfigBoolean(config.jina, true);
}

/**
 * Resolve whether URL sharing is enabled.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_SHARE env var  →  config.share  →  default true
 */
export function resolveSharingEnabled(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_SHARE;
  if (envVal !== undefined) return envVal !== "disabled";
  if (config.share !== undefined) return config.share !== "disabled";
  return true;
}

/**
 * Resolve whether Cursor review jobs pass `--sandbox enabled` to the `agent` CLI.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_CURSOR_SANDBOX env var  →  config.cursorSandbox  →  default true
 *
 * Env values `0` / `false` / `disabled` turn the flag off (the pair is omitted
 * from the argv, deferring to the user's own Cursor Agent configuration);
 * anything else — including `1` / `true` / `enabled` — keeps the default.
 */
export function resolveCursorSandbox(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_CURSOR_SANDBOX;
  if (envVal !== undefined) {
    const v = envVal.toLowerCase();
    return v !== "0" && v !== "false" && v !== "disabled";
  }
  return coerceConfigBoolean(config.cursorSandbox, true);
}
