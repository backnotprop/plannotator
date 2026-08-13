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

import type { DefaultDiffType, DiffLineBgIntensity, DiffOptions, ThemeConfig } from '@plannotator/core/config-types';
export type { DefaultDiffType, DiffLineBgIntensity, DiffOptions, ThemeConfig };

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
   * Full HTTP(S) reverse-proxy origin for remote sessions; range: first port only.
   * Never changes binding; PLANNOTATOR_PUBLIC_URL overrides the config value.
   * Paths, credentials, queries, and fragments are rejected.
   */
  publicUrl?: string;
  /**
   * Host-only override with runtime port; used when publicUrl does not apply.
   * PLANNOTATOR_URL_HOST overrides the config value.
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
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
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
  theme?: ThemeConfig;
  reviewAnalysis: NonNullable<PlannotatorConfig["reviewAnalysis"]>;
  gitUser?: string;
  conventionalComments?: boolean;
  conventionalLabels?: CCLabelConfig[] | null;
} {
  const cfg = loadConfig();
  return {
    displayName: cfg.displayName,
    diffOptions: cfg.diffOptions,
    ...(cfg.theme !== undefined && { theme: cfg.theme }),
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

/** Validate a public reverse-proxy URL as an HTTP(S) origin without a path. */
export function isValidPublicUrl(value: string): boolean {
  const publicUrl = value.trim();
  if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(publicUrl) || !URL.canParse(publicUrl)) {
    return false;
  }
  const url = new URL(publicUrl);
  return (url.protocol === "http:" || url.protocol === "https:")
    && url.username === ""
    && url.password === ""
    && (url.pathname === "" || url.pathname === "/")
    && url.search === ""
    && url.hash === "";
}

const warnedInvalidPublicUrls = new Set<string>();

/**
 * Resolve the full public origin advertised for a reverse-proxied remote session.
 *
 * Priority (highest wins):
 *   PLANNOTATOR_PUBLIC_URL env var  →  config.publicUrl  →  undefined
 *
 * Valid values are normalized to an origin, so a trailing slash and default
 * port do not leak into the displayed link. Invalid values warn once and fall
 * back to urlHost or localhost at the caller.
 */
export function resolvePublicUrl(config: PlannotatorConfig): string | undefined {
  const envVal = process.env.PLANNOTATOR_PUBLIC_URL;
  const raw = envVal !== undefined ? envVal : config.publicUrl;
  if (typeof raw !== "string") return undefined;
  const publicUrl = raw.trim();
  if (publicUrl === "") return undefined;
  if (isValidPublicUrl(publicUrl)) return new URL(publicUrl).origin;
  if (!warnedInvalidPublicUrls.has(publicUrl)) {
    warnedInvalidPublicUrls.add(publicUrl);
    process.stderr.write(
      `[plannotator] Warning: invalid public URL ${JSON.stringify(publicUrl)} — expected an HTTP(S) origin with no credentials, path, query, or fragment; using the advertised host or localhost\n`,
    );
  }
  return undefined;
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
