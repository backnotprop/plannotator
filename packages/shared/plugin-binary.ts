import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  PLANNOTATOR_PLUGIN_PROTOCOL,
  PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
  type PluginCapabilities,
  type PluginFeature,
} from "./plugin-protocol";

export type PluginBinarySource = "env" | "source" | "path" | "standard";

export interface PluginBinaryDiscoveryOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  sourceRoot?: string;
  pathDelimiter?: string;
  exists?: (candidate: string) => boolean;
}

export interface PluginBinaryDiscoveryResult {
  found: boolean;
  path?: string;
  source?: PluginBinarySource;
  checked: string[];
}

export interface PluginBinaryCandidate {
  path: string;
  source: PluginBinarySource;
}

export interface PluginBinaryCandidatesResult {
  candidates: PluginBinaryCandidate[];
  checked: string[];
}

export interface InstallerCommand {
  command: string;
  args: string[];
}

export interface PluginBinaryCompatibilityOptions {
  requiredFeatures?: readonly PluginFeature[];
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["plannotator.exe", "plannotator.cmd", "plannotator.bat", "plannotator"]
    : ["plannotator"];
}

function defaultHomeDir(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform === "win32") return env.USERPROFILE || homedir();
  return env.HOME || homedir();
}

function standardInstallCandidates(
  homeDir: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  const binDir = path.join(homeDir, ".local", "bin");
  const names = executableNames(platform);
  if (platform !== "win32") return names.map((name) => path.join(binDir, name));

  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.push(...names.map((name) => path.join(localAppData, "plannotator", name)));
  }
  candidates.push(...names.map((name) => path.join(binDir, name)));
  return candidates;
}

export function findPlannotatorSourceRoot(
  startDir: string,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const sourceEntry = path.join(current, "apps", "hook", "server", "index.ts");
    const sourceShim = path.join(current, "bin", "plannotator.js");
    if (exists(sourceEntry) && exists(sourceShim)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function discoverPlannotatorBinary(
  options: PluginBinaryDiscoveryOptions = {},
): PluginBinaryDiscoveryResult {
  const result = discoverPlannotatorBinaryCandidates(options);
  const first = result.candidates[0];
  if (!first) return { found: false, checked: result.checked };
  return {
    found: true,
    path: first.path,
    source: first.source,
    checked: result.checked,
  };
}

export function discoverPlannotatorBinaryCandidates(
  options: PluginBinaryDiscoveryOptions = {},
): PluginBinaryCandidatesResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const delimiter = options.pathDelimiter ?? path.delimiter;
  const checked: string[] = [];
  const candidates: PluginBinaryCandidate[] = [];
  const seen = new Set<string>();

  const addIfExists = (candidate: string, source: PluginBinarySource) => {
    checked.push(candidate);
    if (!seen.has(candidate) && exists(candidate)) {
      seen.add(candidate);
      candidates.push({ path: candidate, source });
    }
  };

  const explicit = env.PLANNOTATOR_BIN?.trim();
  if (explicit) {
    addIfExists(explicit, "env");
  }

  if (options.sourceRoot) {
    addIfExists(
      path.join(options.sourceRoot, "bin", platform === "win32" ? "plannotator.cmd" : "plannotator.js"),
      "source",
    );
  }

  const pathDirs = (env.PATH || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of executableNames(platform)) {
      addIfExists(path.join(dir, name), "path");
    }
  }

  const home = options.homeDir ?? defaultHomeDir(env, platform);
  for (const candidate of standardInstallCandidates(home, platform, env)) {
    addIfExists(candidate, "standard");
  }

  return { candidates, checked };
}

export function discoverInstalledPlannotatorBinary(
  options: PluginBinaryDiscoveryOptions = {},
): PluginBinaryDiscoveryResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const checked: string[] = [];
  const home = options.homeDir ?? defaultHomeDir(env, platform);

  for (const candidate of standardInstallCandidates(home, platform, env)) {
    checked.push(candidate);
    if (exists(candidate)) {
      return { found: true, path: candidate, source: "standard", checked };
    }
  }

  return { found: false, checked };
}

export function shouldAutoInstallPlannotator(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.PLANNOTATOR_DISABLE_AUTO_INSTALL?.trim().toLowerCase();
  return raw !== "1" && raw !== "true" && raw !== "yes";
}

function normalizeInstallerVersion(version: string | null | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) return undefined;
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function getOfficialInstallerCommand(
  platform: NodeJS.Platform = process.platform,
  version?: string | null,
): InstallerCommand {
  const installVersion = normalizeInstallerVersion(version);
  if (platform === "win32") {
    const command = installVersion
      ? `& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version '${installVersion}'`
      : "irm https://plannotator.ai/install.ps1 | iex";
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    };
  }

  const command = installVersion
    ? `curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version '${installVersion}'`
    : "curl -fsSL https://plannotator.ai/install.sh | bash";
  return {
    command: "bash",
    args: ["-c", command],
  };
}

export function parsePluginCapabilities(raw: string): PluginCapabilities | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PluginCapabilities>;
    if (parsed.protocol !== PLANNOTATOR_PLUGIN_PROTOCOL) return null;
    if (typeof parsed.protocolVersion !== "number") return null;
    if (typeof parsed.minClientVersion !== "number") return null;
    if (!Array.isArray(parsed.features)) return null;
    if (parsed.daemonReady !== true) return null;
    if (
      "multiSessionDaemon" in parsed &&
      typeof parsed.multiSessionDaemon !== "boolean"
    ) return null;
    return parsed as PluginCapabilities;
  } catch {
    return null;
  }
}

export function isCompatiblePluginBinary(
  capabilities: PluginCapabilities,
  options: PluginBinaryCompatibilityOptions = {},
): boolean {
  const requiredFeatures = options.requiredFeatures ?? [];
  return (
    capabilities.protocol === PLANNOTATOR_PLUGIN_PROTOCOL &&
    capabilities.minClientVersion <= PLANNOTATOR_PLUGIN_PROTOCOL_VERSION &&
    capabilities.protocolVersion >= PLANNOTATOR_PLUGIN_PROTOCOL_VERSION &&
    requiredFeatures.every((feature) => capabilities.features.includes(feature))
  );
}
