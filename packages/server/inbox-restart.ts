import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { INBOX_PLUGIN_REPORTS_LOADED_SINCE, type InboxReloadRuntime, type InboxSessionOutdated } from "@plannotator/core/inbox-types";
import { compareStableVersions, parseStableVersion, CLAUDE_PLUGIN_UPDATE_COMMANDS } from "@plannotator/shared/update-check";
import { readAgentFile, stripJsonComments } from "./agent-files";
import { claudeConfigDir, openCodeConfigDir, piAgentDir, type AgentEnvironment } from "./inbox-agents";

export const PLUGIN_REPORTS_LOADED_SINCE = INBOX_PLUGIN_REPORTS_LOADED_SINCE;

export const CLAUDE_PLUGIN_KEY = "plannotator@plannotator";

export interface LoadedPlugin {
  version: string | null;
  root: string | null;
  loadedAt: number | null;
  onDisk?: string | null;
  host?: "pi" | "oh-my-pi";
}

export interface ClaudePluginInstall {
  version: string | null;
  installPath: string | null;
  lastUpdated: number | null;
  scope: string | null;
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

export function parseLoadedPlugin(value: unknown): LoadedPlugin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
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

export function parseEngine(value: unknown): string | null {
  const text = str(value);
  return text && text.length <= 64 ? text : null;
}

export function parseSessionFolder(value: unknown): string | null {
  return abs(value);
}

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

export function parseClaudePluginInstall(text: string): ClaudePluginInstall | null {
  const records = parseClaudePluginInstalls(text);
  return userRecord(records);
}

const userRecord = (records: readonly ClaudePluginInstall[]) => records.find((r) => r.scope === null || r.scope === "user") ?? records[0] ?? null;

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

const INSTALL_FRESH_MS = 2_000;

export function pluginFolderChangedAt(installPath: string): number | null {
  for (const path of [join(installPath, ".claude-plugin", "plugin.json"), installPath]) {
    try {
      const stat = statSync(path);
      return Math.max(stat.mtimeMs, lstatSync(path).mtimeMs);
    } catch {
    }
  }
  return null;
}

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
    read: () => userRecord(records()),
    changedAt,
    pluginsDir: () => join(claudeConfigDir(environment), "plugins"),
  };
}

const isRelease = (version: string | null | undefined): version is string => !!version && parseStableVersion(version) !== null;

const older = (a: string | null, b: string | null) => isRelease(a) && isRelease(b) && compareStableVersions(a, b) === -1;

export interface ClaudeSessionJudgeInput {
  loaded: LoadedPlugin | null;
  records: readonly ClaudePluginInstall[];
  folder: string | null;
  cliVersion: string;
  pluginsDir: string;
  changedAt?: (installPath: string) => number | null;
}

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
    if (isRelease(installed) && compareStableVersions(installed, PLUGIN_REPORTS_LOADED_SINCE)! >= 0) {
      return { loaded: null, installed, fix: installedBehindInbox ? "update_plugin" : "restart" };
    }
    return installedBehindInbox ? { loaded: null, installed, fix: "update_plugin" } : null;
  }
  if (loaded.root && !isUnder(loaded.root, input.pluginsDir)) return null;
  const versionDiffers = !!loaded.version && !!installed && loaded.version !== installed;
  const folderDiffers = !!loaded.root && !!install.installPath && realish(loaded.root) !== realish(install.installPath);
  const folderChangedAt = install.installPath ? (input.changedAt ?? pluginFolderChangedAt)(install.installPath) : null;
  const loadedBefore =
    loaded.loadedAt !== null &&
    install.lastUpdated !== null &&
    folderChangedAt !== null &&
    loaded.loadedAt < install.lastUpdated &&
    loaded.loadedAt < folderChangedAt;
  if (installedBehindInbox && (older(loaded.version, cliVersion) || !loaded.version)) return { loaded: loaded.version, installed, fix: "update_plugin" };
  if (versionDiffers || folderDiffers || loadedBefore) return { loaded: loaded.version, installed, fix: "restart" };
  return null;
}

export function claudePluginBehindInbox(install: ClaudePluginInstall | null, cliVersion: string): boolean {
  return !!install && older(install.version, cliVersion);
}

export const PI_RELOAD_COMMAND = "/reload";
export const OMP_RESTART_COMMAND = "/restart";
export const PI_UPDATE_COMMAND = "pi update --extensions";
export const PI_INSTALL_LATEST_COMMAND = "pi install npm:@plannotator/pi-extension";
export const OMP_UPGRADE_COMMAND = "omp plugin upgrade @plannotator/pi-extension";
export const OPENCODE2_RELOAD_COMMAND = "opencode2 reload";
export const OPENCODE2_PLUGIN_UPDATE_COMMAND = "opencode2 plugin update";
export const OPENCODE2_LATEST_SPEC = "@plannotator/opencode@latest";

export function openCodeSpecShellSafe(spec: string): boolean {
  return /^@plannotator\/opencode(?:@[\w.-]+)?$/.test(spec);
}

export const OPENCODE2_OPEN_FOLDER_COMMAND = "opencode2 models";

export function opencodePluginUpdateCommand(spec: string | null): string {
  const update = spec && openCodeSpecShellSafe(spec) ? `${OPENCODE2_PLUGIN_UPDATE_COMMAND} ${spec}` : OPENCODE2_PLUGIN_UPDATE_COMMAND;
  return `${OPENCODE2_OPEN_FOLDER_COMMAND} && ${update}`;
}
export const OPENCODE2_SERVICE_RESTART_COMMAND = "opencode2 service restart";

export function piSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string, options: { pinned?: boolean } = {}): InboxSessionOutdated | null {
  if (!loaded?.version) return null;
  if (loaded.onDisk === undefined) {
    if (!older(loaded.version, cliVersion)) return null;
    return { loaded: loaded.version, installed: cliVersion, fix: "update_extension" };
  }
  if (loaded.onDisk === null) return null;
  const omp = loaded.host === "oh-my-pi";
  const reload = { runtime: omp ? "oh-my-pi" : "pi", reload_command: omp ? OMP_RESTART_COMMAND : PI_RELOAD_COMMAND, reload_where: "session" } as const;
  if (loaded.onDisk !== loaded.version) return { loaded: loaded.version, installed: loaded.onDisk, fix: "reload", ...reload };
  if (!older(loaded.version, cliVersion)) return null;
  const update_command = omp ? OMP_UPGRADE_COMMAND : options.pinned ? PI_INSTALL_LATEST_COMMAND : PI_UPDATE_COMMAND;
  return { loaded: loaded.version, installed: loaded.onDisk, fix: "update_extension", update_command, ...reload };
}

export function openCodeSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string, options: { spec?: string | null } = {}): InboxSessionOutdated | null {
  if (!loaded?.version || loaded.onDisk === undefined) return null;
  const base = { runtime: "opencode", reload_where: "shell", fallback_command: OPENCODE2_SERVICE_RESTART_COMMAND } as const;
  if (loaded.onDisk === null || loaded.onDisk !== loaded.version) {
    return { loaded: loaded.version, installed: loaded.onDisk, fix: "reload", reload_command: OPENCODE2_RELOAD_COMMAND, ...base };
  }
  if (!older(loaded.version, cliVersion)) return null;
  const spec = options.spec ?? null;
  if (spec && openCodeSpecPinned(spec)) {
    return { loaded: loaded.version, installed: cliVersion, fix: "update_extension", reload_command: OPENCODE2_RELOAD_COMMAND, pinned_spec: spec, pin_to: OPENCODE2_LATEST_SPEC, ...base };
  }
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

export function openCodeSpecPinned(spec: string): boolean {
  const match = /^@plannotator\/opencode@(.+)$/.exec(spec.trim());
  return !!match && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(match[1]!);
}

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

function openCodeConfigFiles(environment: AgentEnvironment): string[] {
  const explicit = environment.env.OPENCODE_CONFIG?.trim();
  const expanded = explicit?.startsWith("~/") ? join(environment.homeDir, explicit.slice(2)) : explicit;
  const dir = openCodeConfigDir(environment);
  return [...(expanded && isAbsolute(expanded) ? [expanded] : []), ...["opencode.json", "opencode.jsonc", "config.json"].map((name) => join(dir, name))];
}

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

export function runtimeOf(host: string, plugin: LoadedPlugin | null): InboxReloadRuntime | null {
  if (host === "claude-code") return "claude-code";
  if (host === "pi") return plugin?.host === "oh-my-pi" ? "oh-my-pi" : "pi";
  if (host === "opencode") return "opencode";
  return null;
}

const DEFAULT_RELOAD: Record<InboxReloadRuntime, { command: string; where: "session" | "shell"; update: string }> = {
  "claude-code": { command: "/reload-plugins", where: "session", update: CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ") + " --scope user" },
  pi: { command: PI_RELOAD_COMMAND, where: "session", update: PI_UPDATE_COMMAND },
  "oh-my-pi": { command: OMP_RESTART_COMMAND, where: "session", update: OMP_UPGRADE_COMMAND },
  opencode: { command: OPENCODE2_RELOAD_COMMAND, where: "shell", update: opencodePluginUpdateCommand(null) },
};

const RUNTIME_NAMES: Record<InboxReloadRuntime, string> = { "claude-code": "Claude Code", pi: "Pi", "oh-my-pi": "Oh My Pi", opencode: "OpenCode 2" };

export function tagUpdateFix(runtime: InboxReloadRuntime | null, outdated: InboxSessionOutdated | null): string {
  if (!runtime) return "Update Plannotator there.";
  const name = RUNTIME_NAMES[runtime];
  const fallback = DEFAULT_RELOAD[runtime];
  const command = outdated?.reload_command ?? fallback.command;
  const where = outdated?.reload_where ?? fallback.where;
  const reload = where === "shell" ? `run ${command}` : `type ${command} in that ${name}`;
  const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);
  if (outdated && (outdated.fix === "reload" || outdated.fix === "restart")) return `${capital(reload)}.`;
  if (runtime === "claude-code") return `Update Plannotator's plugin, then ${reload}.`;
  if (runtime === "opencode") {
    if (outdated?.pinned_spec) return `Change ${outdated.pinned_spec} to ${outdated.pin_to ?? "@plannotator/opencode@latest"} in OpenCode's config, then run ${command}.`;
    return `Run ${outdated?.update_command ?? fallback.update}.`;
  }
  return `Run ${outdated?.update_command ?? fallback.update}, then ${reload}.`;
}

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

export const CLAUDE_PLUGIN_UPDATE_COMMAND = `${CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ")} --scope user`;

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

export function claudeRestartCommand(folder: string, session: string): string {
  const id = /^[A-Za-z0-9._-]+$/.test(session) ? session : singleQuote(session);
  return `cd ${shellFolder(folder)} && claude --resume ${id}`;
}
