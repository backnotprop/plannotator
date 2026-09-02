/**
 * Plannotator Config
 *
 * Reads/writes ~/.plannotator/config.json for persistent user settings.
 * Runtime-agnostic: uses only node:fs, node:os, node:child_process.
 */

import { join } from "path";
import { getPlannotatorDataDir } from "./data-dir";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  unlinkSync,
  renameSync,
  realpathSync,
} from "fs";
import { execSync } from "child_process";

import type { DefaultDiffType, DiffLineBgIntensity, DiffOptions, ThemeConfig } from '@plannotator/core/config-types';
import { isFaviconStyle, type FaviconStyle } from './favicon';
import { isAnnotateAgentTerminalSide, type AnnotateAgentTerminalSide } from './agent-terminal';
export type { DefaultDiffType, DiffLineBgIntensity, DiffOptions, ThemeConfig, FaviconStyle };

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
  | "gemini-cli"
  | "oh-my-pi";

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
    approvedWithNotes?: string;
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
  /** Optional analysis layers used by code review. */
  reviewAnalysis?: {
    /** Named-entity semantic diff. Enabled by default for backwards compatibility. */
    semanticDiff?: boolean;
    /** Call-stack impact analysis powered by the optional CallDiff runtime. */
    callFlow?: boolean;
  };
  /**
   * Appearance: which mode, plus the palette assigned to each half of the
   * light/dark pair. Written by the UI through POST /api/config, so a choice
   * made in one session is picked up by the next one (each hook invocation
   * runs on its own random port).
   */
  theme?: ThemeConfig;
  prompts?: PromptConfig;
  conventionalComments?: boolean;
  /** null = explicitly cleared (use defaults), undefined = not set */
  conventionalLabels?: CCLabelConfig[] | null;
  /**
   * Where the annotate-mode Agent TUI docks: "left" (the historic default),
   * "right", or "hidden" to keep it out of the layout until the user opens it
   * for a session. Written by the UI through POST /api/config, because every
   * annotate session runs on its own random port — a cookie alone would make
   * the choice per-session rather than per-user.
   *
   * Typed from @plannotator/core rather than restating the union, so this
   * field and `isAgentTerminalSide` cannot disagree with the client-side
   * placement logic about which sides exist.
   */
  agentTerminalSide?: AnnotateAgentTerminalSide;
  /**
   * Which agent the annotate-mode Agent TUI preselects (an agent id such as
   * "claude"). Unset means the first available agent wins. Persisted here for
   * the same random-port reason as agentTerminalSide.
   */
  agentTerminalDefaultAgent?: string;
  /**
   * Enable `gh attestation verify` during CLI installation/upgrade.
   * Read by scripts/install.sh|ps1|cmd on every run (not by any runtime code).
   * When true, the installer runs build-provenance verification after the
   * SHA256 checksum check; requires `gh` CLI installed and authenticated
   * (`gh auth login`). OS-level opt-in only — no UI surface. Default: false.
   */
  verifyAttestation?: boolean;
  /**
   * Per-agent installer integration opt-outs. Read by
   * scripts/install.sh|ps1|cmd on every run (not by any runtime code).
   * When an agent's flag is true, the installer does not write that agent's
   * integration even when the agent is detected, reports the detected state
   * honestly ("detected, skipped"), and never removes an integration a
   * previous install already wired. Overridden by the
   * PLANNOTATOR_SKIP_CODEX_INSTALL / PLANNOTATOR_SKIP_GEMINI_INSTALL /
   * PLANNOTATOR_SKIP_KIRO_INSTALL / PLANNOTATOR_SKIP_OPENCODE_INSTALL env
   * vars, which are in turn overridden by the --skip-codex / --skip-gemini /
   * --skip-kiro / --skip-opencode flags. OpenCode has no detection leg, so
   * its entry is a plain do-not-write switch. Default: all off.
   */
  skipInstall?: {
    codex?: boolean;
    gemini?: boolean;
    kiro?: boolean;
    opencode?: boolean;
  };
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
   * Durably archive every submitted review under ~/.plannotator/feedback/
   * (or PLANNOTATOR_DATA_DIR): one append-only JSONL record per submission
   * plus a markdown sidecar for the ones that carry content. NOTE: this
   * writes the user's own feedback text and the document/code excerpts it
   * quotes to disk, and nothing prunes the directory. Set to false to never
   * write. Default: true. Annotate-surface records additionally honor
   * `annotateHistory`, so the stateless-annotate promise is unchanged.
   */
  feedbackHistory?: boolean;
  /**
   * Extra file extensions annotate treats as markdown (#1307), e.g.
   * [".livemd"] for Livebook notebooks. Listed extensions are accepted
   * everywhere .md is accepted on the annotate path and render as markdown.
   * Entries must start with a dot and carry no path separators or globs;
   * invalid entries are dropped and `.env` can never be registered (annotate
   * copies file contents into the data dir). Resolved by
   * `resolveMarkdownExtensions` in ./markdown-extensions. Default: none.
   */
  markdownExtensions?: string[];
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
   * Base URL of the guide host that `plannotator guide share` and the
   * in-app "Create share link" upload Guided Reviews to (default
   * https://guides.show; a self-hosted `apps/guides-show` origin otherwise).
   * Must be http(s); a trailing slash is trimmed. Mirrors the
   * PLANNOTATOR_GUIDE_SHARE_URL env var, which takes precedence. Guide sharing
   * is off entirely while `share` is "disabled".
   */
  guideShareUrl?: string;
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
  /**
   * Display-only hostname for advertised session URLs (issue #657). Lets a
   * remote-mode user hand out a reachable link (e.g. a Tailscale MagicDNS
   * name or tailnet IP) instead of localhost. Host only — the port is chosen
   * at runtime and always appended. Never affects which interface the server
   * binds; that stays governed by PLANNOTATOR_REMOTE. Applied only in remote
   * sessions: a local session binds loopback, so the override is ignored
   * (localhost is advertised) with a once-per-process stderr warning.
   * Mirrors the PLANNOTATOR_URL_HOST env var, which takes precedence.
   */
  urlHost?: string;
  /**
   * Mirror the approved plan checklist into an editable todo provider during
   * execution (issue #484). "auto" (default) syncs whenever a provider is
   * detected — currently pi-todos. Detection checks the configured todo
   * directory; PI_TODO_PATH only redirects which directory is checked.
   *
   * The mirror is additive: the progress widget is left alone. pi-todos has no
   * live surface of its own (its list renders on demand in `/todos`), so the
   * widget stays the at-a-glance tracker while the provider contributes
   * editable, session-durable todos. Sync is one-way; provider-side edits are
   * never read back. Failures are non-fatal.
   */
  todoProvider?: "auto" | "off";
  /**
   * Selected favicon style for Plannotator application surfaces:
   * 'totman' (production brand mascot) or 'classic' (historical dark-navy P tile).
   */
  favicon?: FaviconStyle;
}

/** Parse the only server-writable call-review analysis flags. */
export function parseReviewAnalysisConfig(value: unknown): PlannotatorConfig["reviewAnalysis"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: NonNullable<PlannotatorConfig["reviewAnalysis"]> = {};
  if (input.semanticDiff !== undefined) {
    if (typeof input.semanticDiff !== "boolean") return undefined;
    result.semanticDiff = input.semanticDiff;
  }
  if (input.callFlow !== undefined) {
    if (typeof input.callFlow !== "boolean") return undefined;
    result.callFlow = input.callFlow;
  }
  return result;
}

// Resolved per call, not at module scope: tests sandbox the data dir by
// setting PLANNOTATOR_DATA_DIR at runtime, and a module-scope constant would
// freeze whatever the env held at first import (bun runs every test file in
// one process).
function getConfigDir(): string {
  return getPlannotatorDataDir();
}
function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

/**
 * Load config from ~/.plannotator/config.json.
 * Returns {} on missing file or malformed JSON.
 */
export function loadConfig(): PlannotatorConfig {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    process.stderr.write(`[plannotator] Warning: failed to read config.json: ${e}\n`);
    return {};
  }
}

// --- config.json write serialization ----------------------------------------
//
// saveConfig is a read-merge-write, and one data dir is routinely shared by
// several Plannotator processes (an annotate session and a review session at
// once is ordinary). Two of them settling a POST /api/config in the same
// window both read the pre-change file, both merge onto it, and the second
// write silently drops the first writer's key while both callers are told the
// save succeeded. An advisory lockfile makes the read-merge-write a critical
// section across processes.
//
// Advisory, bounded, and never fatal, in that order of priority:
//  - O_EXCL create of `${configDir}/config.json.lock` is the only primitive
//    required, so this stays node:fs-only and portable to every runtime that
//    vendors this file (no flock, no native deps, no fcntl semantics).
//  - A lock whose mtime is older than the stale window is assumed to belong
//    to a process that died holding it and is taken over. Holding the lock
//    spans one read plus one write, i.e. microseconds, so a lock this old is
//    not a live writer.
//  - Waiting is bounded by the wait budget. When the budget runs out the
//    write proceeds unlocked with a warning: a lost update is a bad outcome,
//    a server wedged forever on a lockfile is a worse one.
//
// Residual failure mode, stated plainly: two writers that both judge the same
// lock stale in the same instant can both take it, and one update is lost
// exactly as it was before. That needs a >1.5s stall inside a critical
// section that costs microseconds, and the cost of closing it (owner tokens,
// re-verification, a second lock) is not worth paying for a settings file.

const CONFIG_LOCK_SUFFIX = ".lock";
const DEFAULT_CONFIG_LOCK_WAIT_BUDGET_MS = 3000;
const DEFAULT_CONFIG_LOCK_STALE_MS = 1500;
const CONFIG_LOCK_POLL_MS = 10;

let configLockWaitBudgetMs = DEFAULT_CONFIG_LOCK_WAIT_BUDGET_MS;
let configLockStaleMs = DEFAULT_CONFIG_LOCK_STALE_MS;

/**
 * Test-only seam for the lock windows. The bounded-wait and stale-takeover
 * paths are otherwise only reachable by waiting out multi-second real time
 * inside a synchronous function, which no test should do. Pass null to
 * restore the shipping values.
 */
export function __setConfigLockTimingsForTest(
  timings: { waitBudgetMs?: number; staleMs?: number } | null,
): void {
  configLockWaitBudgetMs = timings?.waitBudgetMs ?? DEFAULT_CONFIG_LOCK_WAIT_BUDGET_MS;
  configLockStaleMs = timings?.staleMs ?? DEFAULT_CONFIG_LOCK_STALE_MS;
}

/**
 * Test-only seam: runs inside the lock, after the config has been read and
 * before the merged result is written. It exists so a test can inspect the
 * critical section itself (is the lock actually held across the merge?)
 * rather than racing two writers and hoping the interleaving reproduces.
 */
let configSaveMergeWindowHook: (() => void) | null = null;
export function __setConfigSaveMergeWindowHookForTest(hook: (() => void) | null): void {
  configSaveMergeWindowHook = hook;
}

export function getConfigLockPath(): string {
  return getConfigPath() + CONFIG_LOCK_SUFFIX;
}

/** Block the calling thread without a timer: saveConfig is synchronous, so an
 * event-loop-based sleep would never run. Falls back to a spin when
 * SharedArrayBuffer/Atomics.wait is unavailable on the host runtime. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

/**
 * Take the advisory config lock, or return false when the wait budget ran out
 * (the caller then writes unlocked rather than hanging).
 */
function acquireConfigLock(lockPath: string): boolean {
  const deadline = Date.now() + configLockWaitBudgetMs;
  for (;;) {
    try {
      // wx: create-exclusive. Whoever wins the create owns the section.
      const handle = openSync(lockPath, "wx");
      try {
        writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`);
      } catch { /* the lock is the file's existence, not its contents */ }
      closeSync(handle);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // Unwritable directory, read-only fs: locking is not available here,
        // so do not let it block the write it was only meant to serialize.
        return false;
      }
    }

    // Held by someone else. Take it over once it is too old to be live.
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > configLockStaleMs) {
        unlinkSync(lockPath);
        continue;
      }
    } catch { /* vanished between the create and the stat: just retry */ }

    if (Date.now() >= deadline) return false;
    sleepSync(CONFIG_LOCK_POLL_MS);
  }
}

function releaseConfigLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch { /* already gone (stale takeover by another writer): nothing to do */ }
}

/**
 * Write config.json in one step so a concurrent reader never observes a
 * half-written file: readers deliberately take no lock, and loadConfig treats
 * malformed JSON as an empty config, which would silently present as "all
 * settings reset". Writes through an existing symlink rather than replacing
 * it, so a dotfile-managed config.json keeps its link.
 */
function writeConfigAtomic(configPath: string, contents: string): void {
  let targetPath = configPath;
  try {
    if (existsSync(configPath)) targetPath = realpathSync(configPath);
  } catch { /* unreadable link: fall back to the literal path */ }
  // Rename replaces the destination's metadata with the temp file's, so carry
  // the existing file's permissions across instead of re-deciding them.
  let mode = 0o600;
  try {
    if (existsSync(targetPath)) mode = statSync(targetPath).mode & 0o777;
  } catch { /* new file: keep the private default */ }
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf-8", mode });
    renameSync(tempPath, targetPath);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch { /* nothing to clean up */ }
    // Same-directory rename should not fail, but a write that lands is better
    // than a settings change that is lost to an exotic filesystem.
    writeFileSync(targetPath, contents, "utf-8");
  }
}

/**
 * Save config by merging partial values into the existing file.
 * Creates ~/.plannotator/ directory if needed.
 *
 * The read-merge-write runs under an advisory lockfile so concurrent writers
 * (in this process or another one sharing the data dir) cannot drop each
 * other's keys. See the lock notes above for the failure mode: it degrades to
 * the old unlocked behavior with a warning, never to a hang.
 */
export function saveConfig(partial: Partial<PlannotatorConfig>): void {
  let lockPath: string | null = null;
  let locked = false;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    lockPath = getConfigLockPath();
    locked = acquireConfigLock(lockPath);
    if (!locked) {
      process.stderr.write(
        `[plannotator] Warning: config.json lock unavailable after ${configLockWaitBudgetMs}ms; `
        + `saving without it (a concurrent save may be overwritten).\n`,
      );
    }

    const current = loadConfig();
    configSaveMergeWindowHook?.();
    const mergedDiffOptions = (current.diffOptions || partial.diffOptions)
      ? { ...current.diffOptions, ...partial.diffOptions }
      : undefined;
    const mergedTheme = (current.theme || partial.theme)
      ? { ...current.theme, ...partial.theme }
      : undefined;
    const mergedReviewAnalysis = (current.reviewAnalysis || partial.reviewAnalysis)
      ? { ...current.reviewAnalysis, ...partial.reviewAnalysis }
      : undefined;
    const mergedPrompts = mergePromptConfig(current.prompts, partial.prompts);
    const merged = {
      ...current,
      ...partial,
      diffOptions: mergedDiffOptions,
      theme: mergedTheme,
      reviewAnalysis: mergedReviewAnalysis,
      prompts: mergedPrompts,
    };
    writeConfigAtomic(getConfigPath(), JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`[plannotator] Warning: failed to write config.json: ${e}\n`);
  } finally {
    if (locked && lockPath) releaseConfigLock(lockPath);
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
  theme?: ThemeConfig;
  favicon?: FaviconStyle;
  reviewAnalysis: NonNullable<PlannotatorConfig["reviewAnalysis"]>;
  gitUser?: string;
  conventionalComments?: boolean;
  conventionalLabels?: CCLabelConfig[] | null;
  agentTerminalSide?: PlannotatorConfig["agentTerminalSide"];
  agentTerminalDefaultAgent?: string;
} {
  const cfg = loadConfig();
  return {
    displayName: cfg.displayName,
    diffOptions: cfg.diffOptions,
    ...(cfg.theme !== undefined && { theme: cfg.theme }),
    ...(isFaviconStyle(cfg.favicon) && { favicon: cfg.favicon }),
    // These values gate server-side work, so always make the resolved defaults
    // explicit. The client must not revive a stale cookie that disagrees with
    // the server when the config leaves either optional leaf unset.
    reviewAnalysis: {
      semanticDiff: cfg.reviewAnalysis?.semanticDiff !== false,
      callFlow: cfg.reviewAnalysis?.callFlow === true,
    },
    gitUser: gitUser ?? undefined,
    ...(cfg.conventionalComments !== undefined && { conventionalComments: cfg.conventionalComments }),
    ...(cfg.conventionalLabels !== undefined && { conventionalLabels: cfg.conventionalLabels }),
    ...(isAgentTerminalSide(cfg.agentTerminalSide) && { agentTerminalSide: cfg.agentTerminalSide }),
    ...(typeof cfg.agentTerminalDefaultAgent === "string" &&
      cfg.agentTerminalDefaultAgent !== "" && {
        agentTerminalDefaultAgent: cfg.agentTerminalDefaultAgent,
      }),
  };
}

/**
 * Guard for the annotate Agent TUI placement. config.json is hand-editable, so
 * a bogus value must simply not be advertised — the client then keeps its own
 * resolved default instead of adopting a side that does not exist.
 *
 * The set of sides has exactly one definition, `AnnotateAgentTerminalSide` in
 * @plannotator/core: `PlannotatorConfig.agentTerminalSide` IS that type and
 * this predicate delegates to that module's guard, so neither the union nor
 * its membership test can drift on one side of the boundary. Direct import
 * rather than a duplicated literal check: the Pi vendor step rewrites the
 * relative specifier to the flat `./agent-terminal.ts` it already vendors
 * from core, so both runtimes end up on the same implementation.
 */
export function isAgentTerminalSide(
  value: unknown,
): value is NonNullable<PlannotatorConfig["agentTerminalSide"]> {
  return isAnnotateAgentTerminalSide(value);
}

/**
 * Read the user's preferred default diff type from config, falling back to
 * 'since-base' (the composite "what would GitHub show" view). Users with an
 * explicit defaultDiffType keep their choice.
 */
export function resolveDefaultDiffType(cfg?: PlannotatorConfig): DefaultDiffType {
  const v = cfg?.diffOptions?.defaultDiffType as string | undefined;
  if (v === 'branch') return 'merge-base';
  return v === 'since-base' || v === 'local-vs-remote' || v === 'uncommitted' || v === 'unstaged' || v === 'staged' || v === 'merge-base' || v === 'all' ? v : 'since-base';
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
 * Resolve whether submitted feedback is archived under feedback/.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_FEEDBACK_HISTORY env var  →  config.feedbackHistory  →  default true
 *
 * Deliberately a separate knob from annotateHistory: that one governs copying
 * ANNOTATED CONTENT into the data dir, this one governs keeping the user's own
 * SUBMISSIONS, and a code-review user must be able to control the second
 * without touching the first. Annotate surfaces honor both.
 */
export function resolveFeedbackHistory(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_FEEDBACK_HISTORY;
  if (envVal !== undefined) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }
  return coerceConfigBoolean(config.feedbackHistory, true);
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
export function resolveSharingEnabled(config: PlannotatorConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const envVal = env.PLANNOTATOR_SHARE;
  if (envVal !== undefined) return envVal !== "disabled";
  if (config.share !== undefined) return config.share !== "disabled";
  return true;
}

/** Where shared Guided Reviews are uploaded by default (guide share hosting contract, §7). */
export const DEFAULT_GUIDE_SHARE_URL = "https://guides.show";

/**
 * Validate and normalize a guide share service URL: http(s) only, credentials,
 * query and fragment dropped, trailing slashes trimmed so callers can append
 * `/api/g`. Null when the value must not be used.
 */
export function normalizeGuideShareUrl(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

const warnedInvalidGuideShareUrls = new Set<string>();

/**
 * Resolve the guide host that guide share links are created on.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_GUIDE_SHARE_URL env var  →  config.guideShareUrl  →  https://guides.show
 *
 * An empty (but set) env var counts as unset. A value that is not an http(s)
 * URL warns once per value on stderr and falls back to the default: a share
 * setting must never break a server launch or a CLI run. Whether sharing is
 * allowed at all is a separate question (`resolveSharingEnabled`).
 */
export function resolveGuideShareUrl(config: PlannotatorConfig, env: NodeJS.ProcessEnv = process.env): string {
  const envVal = env.PLANNOTATOR_GUIDE_SHARE_URL;
  const raw = envVal !== undefined && envVal.trim() !== "" ? envVal : config.guideShareUrl;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_GUIDE_SHARE_URL;
  const normalized = normalizeGuideShareUrl(raw);
  if (normalized) return normalized;
  if (!warnedInvalidGuideShareUrls.has(raw)) {
    warnedInvalidGuideShareUrls.add(raw);
    process.stderr.write(
      `[plannotator] Warning: invalid guide share URL ${JSON.stringify(raw)} — expected an http(s) URL; using ${DEFAULT_GUIDE_SHARE_URL}\n`,
    );
  }
  return DEFAULT_GUIDE_SHARE_URL;
}

// Bare hostname or IPv4: letters/digits/dots/hyphens, no leading/trailing
// dot or hyphen. Covers MagicDNS names ("my-machine.tailnet.ts.net").
const URL_HOST_HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
// Bracketed IPv6 literal, e.g. [fd7a::1]; dots allow IPv4-mapped forms.
const URL_HOST_IPV6_RE = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Validate a display host for advertised URLs. Host only: anything carrying a
 * scheme, path, query, credentials, whitespace, or a port (":" outside IPv6
 * brackets — the runtime-chosen port is always appended) is rejected.
 */
export function isValidUrlHost(host: string): boolean {
  return URL_HOST_HOSTNAME_RE.test(host) || URL_HOST_IPV6_RE.test(host);
}

const warnedInvalidUrlHosts = new Set<string>();

/**
 * Resolve the display-only hostname used in advertised session URLs.
 * Returns undefined when unset (callers advertise localhost). An empty (but
 * set) env var suppresses the config key. Callers apply this only to remote
 * sessions; local sessions ignore it (see buildAdvertisedUrl).
 *
 * Priority (highest wins):
 *   PLANNOTATOR_URL_HOST env var  →  config.urlHost  →  undefined
 *
 * An invalid value warns once per value on stderr and falls back to
 * localhost — a display setting must never crash a server launch. The echoed
 * value is JSON-encoded so an embedded newline cannot forge extra stderr
 * lines (hosts surface "Plannotator session ready" lines as clickable links).
 *
 * The sentinel "auto" is returned verbatim (it matches the hostname shape);
 * the advertised-URL layer resolves it via Tailscale detection
 * (packages/server/remote.ts and the Pi network.ts mirror).
 */
export function resolveUrlHost(config: PlannotatorConfig): string | undefined {
  const envVal = process.env.PLANNOTATOR_URL_HOST;
  const raw = envVal !== undefined ? envVal : config.urlHost;
  if (typeof raw !== "string") return undefined;
  const host = raw.trim();
  if (host === "") return undefined;
  if (isValidUrlHost(host)) return host;
  if (!warnedInvalidUrlHosts.has(host)) {
    warnedInvalidUrlHosts.add(host);
    process.stderr.write(
      `[plannotator] Warning: invalid advertised URL host ${JSON.stringify(host)} — expected a bare hostname, IPv4, or bracketed IPv6 (no scheme, port, or path); using localhost\n`,
    );
  }
  return undefined;
}

/**
 * Resolve whether Plannotator-managed AI features are enabled.
 *
 * Set PLANNOTATOR_AI=disabled to prevent provider runtime initialization and
 * hide the corresponding UI. External agents may still open Plannotator as a
 * review surface and submit annotations through the external annotation API.
 */
export function resolveAIEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PLANNOTATOR_AI?.toLowerCase() !== "disabled";
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

/**
 * Resolve whether the approved plan checklist is mirrored into an editable todo
 * provider during execution.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_TODO_PROVIDER env var  →  config.todoProvider  →  default auto
 *
 * Env values `off` / `0` / `false` / `disabled` turn the mirror off, matching
 * the vocabulary the other flags accept; anything else — including `auto` —
 * keeps it on. Enabled only means "sync when a provider is detected": with no
 * provider present, the progress widget is the whole experience either way.
 */
export function resolveTodoProviderEnabled(config: PlannotatorConfig): boolean {
  const envVal = process.env.PLANNOTATOR_TODO_PROVIDER;
  if (envVal !== undefined) {
    const v = envVal.toLowerCase();
    return v !== "off" && v !== "0" && v !== "false" && v !== "disabled";
  }
  if (config.todoProvider !== undefined) return config.todoProvider !== "off";
  return true;
}
