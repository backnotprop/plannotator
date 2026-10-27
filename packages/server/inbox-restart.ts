/**
 * Plannotator Inbox: which agent sessions need a restart after an update
 * (owner approval "restart-warning", 2026-10-19; design record not in this
 * repo).
 *
 * The Claude Code mod reports what it loaded on every bridge poll
 * (`plugin: { version, root, loaded_at }`, read once when the module loads,
 * and `engine`). A restart of that Claude Code would load the plugin Claude
 * Code has installed now, which its registry records
 * (`<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`: `version`,
 * `installPath`, `lastUpdated`). A session is outdated when what it loaded is
 * not what a restart loads:
 *  - the versions differ;
 *  - its plugin folder is not the installed one (an update into a new folder);
 *  - it loaded the plugin before the registry's `lastUpdated` AND before the
 *    install folder last changed (an update that reused the folder and kept
 *    the version: only this rule catches it; `lastUpdated` alone moves for a
 *    project-scope install of the same folder with no new code).
 * The record judged against is the one a restart would load: the record whose
 * `installPath` is the folder the session loaded, then a project-scope record
 * whose `projectPath` holds the session's folder, then the user record. Only
 * `plannotator@plannotator` counts (a fork from another marketplace is
 * another plugin). Paths compare by their real paths (`realish`).
 * A session that polls with no `plugin` field runs a mod older than the field
 * (`PLUGIN_REPORTS_LOADED_SINCE`); when the installed plugin is at least that
 * release, a restart loads a newer one, so it is outdated with its version
 * unknown.
 *
 * When the installed plugin is itself behind this Inbox's Plannotator (the
 * plugin was not updated: `--skip-claude-plugin`, a marketplace not updated),
 * a restart does not help: `fix: "update_plugin"`, with the command.
 *
 * Only the rules above are judged for a plugin loaded from Claude Code's own
 * plugin folder. A session started with `claude --plugin-dir <dir>` (a
 * checkout) reloads that folder when restarted, so the installed record says
 * nothing about it: never outdated.
 *
 * Pi, Oh My Pi and OpenCode 2 (owner approval "reload-hosts", 2026-10-26)
 * report what they loaded and what is on disk now: `plugin: { version,
 * on_disk, host }` (Pi and Oh My Pi, which polls as host `pi` and says
 * `host: "oh-my-pi"`), `plugin: { version, on_disk }` (OpenCode 2, `on_disk`
 * null when its plugin generation folder was deleted under it).
 *  - Pi: `on_disk` differs from `version` (the package was updated in place
 *    under the running session, which breaks its lazy imports, #2085):
 *    `/reload`. Both equal and behind this Inbox: `pi update --extensions`
 *    (`pi install npm:@plannotator/pi-extension` for a pinned install), then
 *    `/reload`.
 *  - Oh My Pi: the same, with `/restart` (`/reload-plugins` does not reload
 *    extension code) and `omp plugin upgrade @plannotator/pi-extension`.
 *  - OpenCode 2: the plugin runs in a background service that outlives every
 *    TUI, so quitting OpenCode loads nothing. Its generation folder deleted
 *    (the install script clears the cache): `opencode2 reload`, which
 *    installs the newest version and loads it. Still there and behind this
 *    Inbox: `opencode2 plugin update`, which loads a newer generation through
 *    the running service (a reload alone would load the same generation
 *    again). `opencode2 service restart` is the fallback.
 * An older Pi connection that sends `{ version }` alone keeps the old rule:
 * behind this Inbox's release, `update_extension`.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { INBOX_PLUGIN_REPORTS_LOADED_SINCE, type InboxReloadRuntime, type InboxSessionOutdated } from "@plannotator/core/inbox-types";
import { compareStableVersions, parseStableVersion, CLAUDE_PLUGIN_UPDATE_COMMANDS } from "@plannotator/shared/update-check";
import { readAgentFile, stripJsonComments } from "./agent-files";
import { claudeConfigDir, openCodeConfigDir, piAgentDir, type AgentEnvironment } from "./inbox-agents";

/**
 * The first Plannotator release whose Claude Code mod reports `plugin` on its
 * poll (one constant, in core, beside `INBOX_SEND_NOW_SINCE`). An installed
 * plugin at least this new, polled by a session that sends no `plugin`,
 * means a restart loads a newer plugin than the session runs. This must merge
 * before the version bump to it.
 */
export const PLUGIN_REPORTS_LOADED_SINCE = INBOX_PLUGIN_REPORTS_LOADED_SINCE;

/**
 * Plannotator's plugin as the repo's marketplace names it
 * (`.claude-plugin/marketplace.json`: marketplace `plannotator`, plugin
 * `plannotator`). A fork installed from another marketplace is another plugin
 * and is never judged against.
 */
export const CLAUDE_PLUGIN_KEY = "plannotator@plannotator";

/** What a session's poll said it loaded (validated). */
export interface LoadedPlugin {
  version: string | null;
  root: string | null;
  /** When the module loaded, ms. */
  loadedAt: number | null;
  /**
   * The package's version on disk now (Pi, Oh My Pi, OpenCode 2): a string,
   * null when the package is gone from disk, absent when the connection does
   * not send the field (Claude Code, an older Pi).
   */
  onDisk?: string | null;
  /** `oh-my-pi` when a Pi connection runs inside Oh My Pi. */
  host?: "pi" | "oh-my-pi";
}

/** One record of Plannotator's plugin in Claude Code's registry. */
export interface ClaudePluginInstall {
  version: string | null;
  installPath: string | null;
  /** `lastUpdated` (else `installedAt`), ms. */
  lastUpdated: number | null;
  /** `user`, `project`, `local`... (absent in the v1 file: user). */
  scope: string | null;
  /** The project a project- or local-scope record belongs to. */
  projectPath: string | null;
}

const MAX_FIELD = 4096;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= MAX_FIELD ? value.trim() : null);
const abs = (value: unknown): string | null => {
  const text = str(value);
  return text && isAbsolute(text) ? text : null;
};
const ms = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

/**
 * A poll's `plugin` field: null only when absent (a mod older than the
 * field). A current mod always sends it, with `version` or `root` null when it
 * could not read them, so a read that failed is never taken for an old mod.
 */
export function parseLoadedPlugin(value: unknown): LoadedPlugin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // `on_disk`: a version, or null for a package gone from disk; anything else counts as not sent.
  const onDisk = !("on_disk" in record) ? undefined : record.on_disk === null ? null : (str(record.on_disk) ?? undefined);
  const host = record.host === "oh-my-pi" || record.host === "pi" ? record.host : undefined;
  return {
    version: str(record.version),
    root: abs(record.root),
    loadedAt: ms(record.loaded_at),
    ...(onDisk !== undefined && (onDisk === null || onDisk.length <= 64) ? { onDisk } : {}),
    ...(host ? { host } : {}),
  };
}

/** A poll's `engine` field (Claude Code's own version). */
export function parseEngine(value: unknown): string | null {
  const text = str(value);
  return text && text.length <= 64 ? text : null;
}

/** A poll's `session_folder`: where the session started (its `claude --resume` folder). */
export function parseSessionFolder(value: unknown): string | null {
  return abs(value);
}

/** Every record of `plannotator@plannotator` in `installed_plugins.json` (v2 `{ plugins: { id: [records] } }`, or the v1 object). */
export function parseClaudePluginInstalls(text: string): ClaudePluginInstall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as { plugins?: unknown } & Record<string, unknown>;
  const table = (root.plugins && typeof root.plugins === "object" ? root.plugins : root) as Record<string, unknown>;
  const value = table[CLAUDE_PLUGIN_KEY];
  const out: ClaudePluginInstall[] = [];
  for (const record of Array.isArray(value) ? value : value ? [value] : []) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const r = record as Record<string, unknown>;
    out.push({
      version: str(r.version),
      installPath: abs(r.installPath),
      lastUpdated: ms(r.lastUpdated) ?? ms(r.installedAt),
      scope: str(r.scope),
      projectPath: abs(r.projectPath),
    });
  }
  return out;
}

/** The user-scope record (a record without `scope`, the v1 file, counts as user), else the first. */
export function parseClaudePluginInstall(text: string): ClaudePluginInstall | null {
  const records = parseClaudePluginInstalls(text);
  return userRecord(records);
}

const userRecord = (records: readonly ClaudePluginInstall[]) => records.find((r) => r.scope === null || r.scope === "user") ?? records[0] ?? null;

/**
 * A path as the file system sees it: the real path of its deepest existing
 * part, the rest joined on. Both sides of every comparison go through it, so a
 * symlinked `~/.claude` or CLAUDE_CONFIG_DIR neither hides nor invents a
 * difference, and a folder deleted since (an old version's cache) still
 * compares by where it was.
 */
export function realish(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length ? join(realpathSync(head), ...rest.reverse()) : realpathSync(head);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.push(basename(head));
      head = up;
    }
  }
}

const isUnder = (path: string, dir: string) => {
  const a = realish(path);
  const b = realish(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/**
 * The record a restart of this session would load: the one whose
 * `installPath` is the folder the session loaded, then a project- or
 * local-scope record whose `projectPath` holds the session's folder, then the
 * user record.
 */
export function chooseClaudePluginInstall(
  records: readonly ClaudePluginInstall[],
  session: { loadedRoot: string | null; folder: string | null },
): ClaudePluginInstall | null {
  if (records.length === 0) return null;
  if (session.loadedRoot) {
    const root = realish(session.loadedRoot);
    const same = records.find((r) => r.installPath && realish(r.installPath) === root);
    if (same) return same;
  }
  if (session.folder) {
    const holding = records
      .filter((r) => r.projectPath && r.scope !== "user" && isUnder(session.folder!, r.projectPath))
      .sort((a, b) => realish(b.projectPath!).length - realish(a.projectPath!).length)[0];
    if (holding) return holding;
  }
  return userRecord(records);
}

/** How long a read of the registry is reused: every poll and every window read asks. */
const INSTALL_FRESH_MS = 2_000;

/**
 * When an installed plugin folder last changed: its `.claude-plugin/plugin.json`
 * (rewritten by every install into it), else the folder itself; null when
 * neither exists.
 */
export function pluginFolderChangedAt(installPath: string): number | null {
  for (const path of [join(installPath, ".claude-plugin", "plugin.json"), installPath]) {
    try {
      const stat = statSync(path);
      return Math.max(stat.mtimeMs, lstatSync(path).mtimeMs);
    } catch {
      // Next.
    }
  }
  return null;
}

/** Reads Claude Code's plugin registry for Plannotator's records, at most once per `INSTALL_FRESH_MS`. */
export function createClaudePluginInstallReader(environment: AgentEnvironment, now: () => number = Date.now) {
  let cached: { at: number; value: ClaudePluginInstall[] } | null = null;
  const changed = new Map<string, { at: number; value: number | null }>();
  const records = (): ClaudePluginInstall[] => {
    if (cached && now() - cached.at < INSTALL_FRESH_MS) return cached.value;
    const file = readAgentFile(join(claudeConfigDir(environment), "plugins", "installed_plugins.json"));
    const value = file.kind === "file" ? parseClaudePluginInstalls(file.text) : [];
    cached = { at: now(), value };
    return value;
  };
  const changedAt = (installPath: string): number | null => {
    const hit = changed.get(installPath);
    if (hit && now() - hit.at < INSTALL_FRESH_MS) return hit.value;
    const value = pluginFolderChangedAt(installPath);
    changed.set(installPath, { at: now(), value });
    return value;
  };
  return {
    records,
    /** The user-scope record: what a restart in a folder with no project install of its own loads. */
    read: () => userRecord(records()),
    changedAt,
    pluginsDir: () => join(claudeConfigDir(environment), "plugins"),
  };
}

const isRelease = (version: string | null | undefined): version is string => !!version && parseStableVersion(version) !== null;

/** Whether `a` is older than `b`, both releases; false when either is not one. */
const older = (a: string | null, b: string | null) => isRelease(a) && isRelease(b) && compareStableVersions(a, b) === -1;

export interface ClaudeSessionJudgeInput {
  /** What the session's poll said it loaded; null: it sent no `plugin` (a mod older than the field). */
  loaded: LoadedPlugin | null;
  /** The registry's records of `plannotator@plannotator`; the right one is chosen for this session. */
  records: readonly ClaudePluginInstall[];
  /** Where the session started (its folder), for a project-scope record. */
  folder: string | null;
  cliVersion: string;
  /** Claude Code's plugin folder. */
  pluginsDir: string;
  /** When an install folder last changed (`pluginFolderChangedAt`). */
  changedAt?: (installPath: string) => number | null;
}

/**
 * Claude Code: whether a session runs an older plugin than a restart loads,
 * or than this Inbox. `cliVersion` is this Inbox's version (`dev` and other
 * non-releases skip the plugin-behind-Inbox rule).
 */
export function claudeSessionOutdated(input: ClaudeSessionJudgeInput): InboxSessionOutdated | null {
  const outdated = judgeClaudeSession(input);
  return outdated?.fix === "update_plugin" ? { ...outdated, update_command: CLAUDE_PLUGIN_UPDATE_COMMAND } : outdated;
}

function judgeClaudeSession(input: ClaudeSessionJudgeInput): InboxSessionOutdated | null {
  const { loaded, cliVersion } = input;
  const install = chooseClaudePluginInstall(input.records, { loadedRoot: loaded?.root ?? null, folder: input.folder });
  if (!install) return null;
  const installed = install.version;
  const installedBehindInbox = older(installed, cliVersion);
  if (!loaded) {
    // A mod older than the field. It runs at most the installed plugin; when that is new enough to report, a restart brings it.
    if (isRelease(installed) && compareStableVersions(installed, PLUGIN_REPORTS_LOADED_SINCE)! >= 0) {
      return { loaded: null, installed, fix: installedBehindInbox ? "update_plugin" : "restart" };
    }
    return installedBehindInbox ? { loaded: null, installed, fix: "update_plugin" } : null;
  }
  // A plugin loaded from outside Claude Code's plugin folder reloads that same folder when restarted, so the
  // registry says nothing about it: `claude --plugin-dir <dir>`, and a local (directory) marketplace, which
  // Claude Code loads in place. Never flagged.
  if (loaded.root && !isUnder(loaded.root, input.pluginsDir)) return null;
  const versionDiffers = !!loaded.version && !!installed && loaded.version !== installed;
  const folderDiffers = !!loaded.root && !!install.installPath && realish(loaded.root) !== realish(install.installPath);
  // Reinstalled into the same folder with the same version after the session loaded it: only the load time
  // tells. The registry's `lastUpdated` alone is not enough (a project-scope install of the same folder bumps
  // it with no new code), so the folder itself must have changed since the session loaded it too.
  const folderChangedAt = install.installPath ? (input.changedAt ?? pluginFolderChangedAt)(install.installPath) : null;
  const loadedBefore =
    loaded.loadedAt !== null &&
    install.lastUpdated !== null &&
    folderChangedAt !== null &&
    loaded.loadedAt < install.lastUpdated &&
    loaded.loadedAt < folderChangedAt;
  // Behind this Inbox, and the installed plugin too: a restart alone loads another old plugin.
  if (installedBehindInbox && (older(loaded.version, cliVersion) || !loaded.version)) return { loaded: loaded.version, installed, fix: "update_plugin" };
  if (versionDiffers || folderDiffers || loadedBefore) return { loaded: loaded.version, installed, fix: "restart" };
  return null;
}

/** Whether Claude Code's installed plugin is behind this Inbox's release (a restart alone would not help). */
export function claudePluginBehindInbox(install: ClaudePluginInstall | null, cliVersion: string): boolean {
  return !!install && older(install.version, cliVersion);
}

/** Pi's reload: typed in the session; it reloads the extension from disk in place (Pi 0.79.9+). */
export const PI_RELOAD_COMMAND = "/reload";
/** Oh My Pi imports extensions once per process: `/restart` restarts omp and resumes the session (18.0.10+). */
export const OMP_RESTART_COMMAND = "/restart";
/** Updates Plannotator's Pi extension in place (skips a pinned source). */
export const PI_UPDATE_COMMAND = "pi update --extensions";
/** A pinned source: install the newest version over it. */
export const PI_INSTALL_LATEST_COMMAND = "pi install npm:@plannotator/pi-extension";
/** Oh My Pi's own updater for the extension it loads as a plugin. */
export const OMP_UPGRADE_COMMAND = "omp plugin upgrade @plannotator/pi-extension";
/** OpenCode 2: reload every location of the running service (reinstalls a plugin whose cache was deleted). */
export const OPENCODE2_RELOAD_COMMAND = "opencode2 reload";
/**
 * OpenCode 2: install a newer plugin generation and load it through the running service.
 * Without a target it updates EVERY outdated plugin: the Inbox names Plannotator's
 * configured spec (`opencodePluginUpdateCommand`) whenever it can read it.
 */
export const OPENCODE2_PLUGIN_UPDATE_COMMAND = "opencode2 plugin update";
/** What a pinned OpenCode 2 config entry changes to. */
export const OPENCODE2_LATEST_SPEC = "@plannotator/opencode@latest";

/**
 * A spec safe to paste into a shell unquoted: the name, or the name with a
 * version or tag made only of letters, digits, `_`, `.` and `-`
 * (`@latest`, `@next`, `@0.28.31`). A range (`@>=0.28.0`, `@^0.28.0`) is not:
 * `>` would redirect, `|` would pipe.
 */
export function openCodeSpecShellSafe(spec: string): boolean {
  return /^@plannotator\/opencode(?:@[\w.-]+)?$/.test(spec);
}

/**
 * Runs first, in the same paste: `opencode2 plugin update` answers for the
 * folder it runs in, and in a folder the service has not opened yet its
 * plugins are not loaded: with a target it fails ("Plugin is not configured:
 * @plannotator/opencode@latest"), without one it says "No plugin updates
 * available". The first OpenCode command in a folder opens it; the next one
 * sees its plugins. Measured on OpenCode 2.0.22 in fresh folders: the update
 * alone 0/5, after `opencode2 plugin list` 5/5 (bash and zsh, with and without
 * a target). `&&` is valid in bash, zsh, fish, PowerShell 7 and cmd.
 */
export const OPENCODE2_OPEN_FOLDER_COMMAND = "opencode2 plugin list";

/** `opencode2 plugin update <spec>`: only Plannotator. OpenCode wants the spec exactly as configured (`@plannotator/opencode@latest`; the bare name is "not configured"). A spec that is not shell-safe gives the command with no target. Either way after OPENCODE2_OPEN_FOLDER_COMMAND. */
export function opencodePluginUpdateCommand(spec: string | null): string {
  const update = spec && openCodeSpecShellSafe(spec) ? `${OPENCODE2_PLUGIN_UPDATE_COMMAND} ${spec}` : OPENCODE2_PLUGIN_UPDATE_COMMAND;
  return `${OPENCODE2_OPEN_FOLDER_COMMAND} && ${update}`;
}
/** OpenCode 2: when a reload does not take, restart the background service. */
export const OPENCODE2_SERVICE_RESTART_COMMAND = "opencode2 service restart";

/**
 * Pi and Oh My Pi (`loaded.host`): the package on disk differs from what the
 * session loaded (`/reload`, Oh My Pi `/restart`), or both are behind this
 * Inbox's release (update, then reload). `pinned`: Pi's settings name an
 * exact version, which `pi update --extensions` skips.
 * A connection that sends no `on_disk` (older than the field) keeps the old
 * rule: behind this Inbox's release, `update_extension` with no runtime.
 */
export function piSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string, options: { pinned?: boolean } = {}): InboxSessionOutdated | null {
  if (!loaded?.version) return null;
  if (loaded.onDisk === undefined) {
    if (!older(loaded.version, cliVersion)) return null;
    return { loaded: loaded.version, installed: cliVersion, fix: "update_extension" };
  }
  // Gone from disk (uninstalled): a reload would unload Plannotator, not update it. Nothing to say.
  if (loaded.onDisk === null) return null;
  const omp = loaded.host === "oh-my-pi";
  const reload = { runtime: omp ? "oh-my-pi" : "pi", reload_command: omp ? OMP_RESTART_COMMAND : PI_RELOAD_COMMAND, reload_where: "session" } as const;
  if (loaded.onDisk !== loaded.version) return { loaded: loaded.version, installed: loaded.onDisk, fix: "reload", ...reload };
  if (!older(loaded.version, cliVersion)) return null;
  const update_command = omp ? OMP_UPGRADE_COMMAND : options.pinned ? PI_INSTALL_LATEST_COMMAND : PI_UPDATE_COMMAND;
  return { loaded: loaded.version, installed: loaded.onDisk, fix: "update_extension", update_command, ...reload };
}

/**
 * OpenCode 2: its plugin generation folder was deleted under the running
 * service (the install script clears the cache: `opencode2 reload` installs
 * the newest version and loads it), or the plugin is behind this Inbox's
 * release and still on disk (`opencode2 plugin update` loads a newer
 * generation through the running service; a reload would load the same
 * generation again). Quitting OpenCode loads nothing: the service outlives
 * every TUI. A connection that sends no `on_disk` says nothing.
 */
export function openCodeSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string, options: { spec?: string | null } = {}): InboxSessionOutdated | null {
  if (!loaded?.version || loaded.onDisk === undefined) return null;
  const base = { runtime: "opencode", reload_where: "shell", fallback_command: OPENCODE2_SERVICE_RESTART_COMMAND } as const;
  if (loaded.onDisk === null || loaded.onDisk !== loaded.version) {
    return { loaded: loaded.version, installed: loaded.onDisk, fix: "reload", reload_command: OPENCODE2_RELOAD_COMMAND, ...base };
  }
  if (!older(loaded.version, cliVersion)) return null;
  const spec = options.spec ?? null;
  // A pinned exact version: `opencode2 plugin update` reports nothing to update. The pin changes by hand, then a reload.
  if (spec && openCodeSpecPinned(spec)) {
    return { loaded: loaded.version, installed: cliVersion, fix: "update_extension", reload_command: OPENCODE2_RELOAD_COMMAND, pinned_spec: spec, pin_to: OPENCODE2_LATEST_SPEC, ...base };
  }
  // The update loads the new generation itself (no reload after it); without a known, shell-safe spec it names no target.
  const command = opencodePluginUpdateCommand(spec);
  return {
    loaded: loaded.version,
    installed: cliVersion,
    fix: "update_extension",
    update_command: command,
    ...(command === opencodePluginUpdateCommand(null) ? { update_scope: "all" as const } : {}),
    ...base,
  };
}

/** `@plannotator/opencode@0.28.20`: an exact version, which `opencode2 plugin update` never moves. */
export function openCodeSpecPinned(spec: string): boolean {
  const match = /^@plannotator\/opencode@(.+)$/.exec(spec.trim());
  return !!match && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(match[1]!);
}

/**
 * Plannotator's entry in an OpenCode config, exactly as written: what
 * `opencode2 plugin update` takes as its target. OpenCode 2 reads `plugins`
 * (a string or `{ package }`) and OpenCode 1's `plugin` (a string or a
 * `[spec, options]` pair), which our installer writes. Null when the config
 * has none (or cannot be read).
 */
export function openCodePluginSpec(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const config = parsed as { plugins?: unknown; plugin?: unknown };
  for (const list of [config.plugins, config.plugin]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const spec =
        typeof entry === "string"
          ? entry
          : Array.isArray(entry)
            ? entry[0]
            : entry && typeof entry === "object"
              ? (entry as { package?: unknown }).package
              : null;
      if (typeof spec === "string" && /^@plannotator\/opencode(?:@|$)/.test(spec.trim())) return spec.trim();
    }
  }
  return null;
}

/** The config files to read, in order: `OPENCODE_CONFIG` (an explicit file) when set, then the global folder's. */
function openCodeConfigFiles(environment: AgentEnvironment): string[] {
  const explicit = environment.env.OPENCODE_CONFIG?.trim();
  const expanded = explicit?.startsWith("~/") ? join(environment.homeDir, explicit.slice(2)) : explicit;
  const dir = openCodeConfigDir(environment);
  return [...(expanded && isAbsolute(expanded) ? [expanded] : []), ...["opencode.json", "opencode.jsonc", "config.json"].map((name) => join(dir, name))];
}

/** The global OpenCode config's Plannotator spec (read at most every 2 s), for the update command and the pin. */
export function createOpenCodeSpecReader(environment: AgentEnvironment, now: () => number = Date.now) {
  let cached: { at: number; value: string | null } | null = null;
  return (): string | null => {
    if (cached && now() - cached.at < INSTALL_FRESH_MS) return cached.value;
    let value: string | null = null;
    for (const path of openCodeConfigFiles(environment)) {
      const file = readAgentFile(path);
      if (file.kind !== "file") continue;
      value = openCodePluginSpec(file.text);
      if (value) break;
    }
    cached = { at: now(), value };
    return value;
  };
}

/**
 * Whether Pi's settings pin Plannotator's extension to an exact version
 * (`npm:@plannotator/pi-extension@0.28.20`), which `pi update --extensions`
 * skips. `text` is Pi's settings.json (comments allowed).
 */
export function piExtensionPinned(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return false;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { source?: unknown }).source : null;
    if (typeof source !== "string") return false;
    const match = /^npm:@plannotator\/pi-extension@(.+)$/.exec(source.trim());
    return !!match && /^v?\d+\.\d+\.\d+/.test(match[1]!);
  });
}

/** The runtime a polling session runs in: a Pi connection inside Oh My Pi says `plugin.host: "oh-my-pi"`. Null for another host. */
export function runtimeOf(host: string, plugin: LoadedPlugin | null): InboxReloadRuntime | null {
  if (host === "claude-code") return "claude-code";
  if (host === "pi") return plugin?.host === "oh-my-pi" ? "oh-my-pi" : "pi";
  if (host === "opencode") return "opencode";
  return null;
}

/** What loads new code in each runtime when nothing more precise is known. */
const DEFAULT_RELOAD: Record<InboxReloadRuntime, { command: string; where: "session" | "shell"; update: string }> = {
  "claude-code": { command: "/reload-plugins", where: "session", update: CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ") + " --scope user" },
  pi: { command: PI_RELOAD_COMMAND, where: "session", update: PI_UPDATE_COMMAND },
  "oh-my-pi": { command: OMP_RESTART_COMMAND, where: "session", update: OMP_UPGRADE_COMMAND },
  opencode: { command: OPENCODE2_RELOAD_COMMAND, where: "shell", update: opencodePluginUpdateCommand(null) },
};

const RUNTIME_NAMES: Record<InboxReloadRuntime, string> = { "claude-code": "Claude Code", pi: "Pi", "oh-my-pi": "Oh My Pi", opencode: "OpenCode 2" };

/**
 * One sentence for the `tag_needs_update` refusal: the host's own command
 * ("Type /reload in that Pi."), with the update first when the plugin on disk
 * is behind this Inbox too. A session the Inbox cannot judge (a development
 * Inbox, an older connection) gets the update and the reload: tags need a
 * newer Plannotator there whatever is on disk.
 */
export function tagUpdateFix(runtime: InboxReloadRuntime | null, outdated: InboxSessionOutdated | null): string {
  if (!runtime) return "Update Plannotator there.";
  const name = RUNTIME_NAMES[runtime];
  const fallback = DEFAULT_RELOAD[runtime];
  const command = outdated?.reload_command ?? fallback.command;
  const where = outdated?.reload_where ?? fallback.where;
  // Plain words: the window draws this text as it is (no Markdown).
  const reload = where === "shell" ? `run ${command}` : `type ${command} in that ${name}`;
  const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);
  if (outdated && (outdated.fix === "reload" || outdated.fix === "restart")) return `${capital(reload)}.`;
  // Claude Code's update is two long commands: Settings, Agents has them with Copy.
  if (runtime === "claude-code") return `Update Plannotator's plugin, then ${reload}.`;
  if (runtime === "opencode") {
    if (outdated?.pinned_spec) return `Change ${outdated.pinned_spec} to ${outdated.pin_to ?? "@plannotator/opencode@latest"} in OpenCode's config, then run ${command}.`;
    // OpenCode 2's plugin update loads the new generation itself: no reload after it.
    return `Run ${outdated?.update_command ?? fallback.update}.`;
  }
  return `Run ${outdated?.update_command ?? fallback.update}, then ${reload}.`;
}

/** Reads Pi's settings for a pinned Plannotator source, at most once per `INSTALL_FRESH_MS`. */
export function createPiPinReader(environment: AgentEnvironment, now: () => number = Date.now) {
  let cached: { at: number; value: boolean } | null = null;
  return (): boolean => {
    if (cached && now() - cached.at < INSTALL_FRESH_MS) return cached.value;
    const file = readAgentFile(join(piAgentDir(environment), "settings.json"));
    const value = file.kind === "file" ? piExtensionPinned(file.text) : false;
    cached = { at: now(), value };
    return value;
  };
}

/** The command that updates the Claude Code plugin itself (the install script's two steps). */
export const CLAUDE_PLUGIN_UPDATE_COMMAND = `${CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ")} --scope user`;

/** A folder for a shell line: `~` kept unquoted at the start, anything unusual single-quoted. */
export function shellFolder(folder: string): string {
  const safe = /^[A-Za-z0-9_./+@:,=-]+$/;
  if (folder === "~") return "~";
  if (folder.startsWith("~/")) {
    const rest = folder.slice(2);
    return rest === "" || safe.test(rest) ? folder : `~/${singleQuote(rest)}`;
  }
  return safe.test(folder) ? folder : singleQuote(folder);
}

const singleQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `cd <folder> && claude --resume <session>`: the same Claude Code session again, in its folder. */
export function claudeRestartCommand(folder: string, session: string): string {
  const id = /^[A-Za-z0-9._-]+$/.test(session) ? session : singleQuote(session);
  return `cd ${shellFolder(folder)} && claude --resume ${id}`;
}
