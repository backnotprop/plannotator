/**
 * Plannotator uninstall lifecycle.
 *
 * The uninstaller removes only product-owned paths and recognizable managed
 * entries from shared host configuration. The default mode keeps local review
 * data. Purge removes the known Plannotator data inventory while preserving
 * unknown top-level entries rather than guessing that custom files are ours.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
} from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  type ParseError,
} from "jsonc-parser";

const CORE_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-last",
] as const;

const EXTRA_SKILLS = [
  "plannotator-compound",
  "plannotator-setup-goal",
  "plannotator-visual-explainer",
] as const;

const LEGACY_COMMAND_NAMES = [
  ...CORE_SKILLS,
  "plannotator-archive",
] as const;

const KIRO_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-setup-goal",
  "plannotator-visual-explainer",
  "plannotator-archive",
] as const;

const STALE_CODEX_SKILLS = [
  ...CORE_SKILLS,
  "plannotator-compound",
  "plannotator-setup-goal",
  "plannotator-archive",
] as const;

const STALE_SHARED_SKILLS = [
  "plannotator-archive",
] as const;

const PURGE_OWNED_TOP_LEVEL = [
  "plans",
  "history",
  "drafts",
  "active",
  "hooks",
  "compound",
  "sessions",
  "guides",
  "failed-comments",
  "semantic-diff",
  "migrations",
  "config.json",
  "install-prefs",
  "review-skills.json",
  "vscode-ipc.json",
  "codex-review-debug.log",
  "codex-review-schema.json",
  "tour-schema.json",
  "guide-schema.json",
] as const;

const WINDOWS_PATH_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$p=[Environment]::GetEnvironmentVariable('Path','User')",
  "if($null -eq $p){exit 3}",
  "$t=$env:PLANNOTATOR_UNINSTALL_PATH.Trim().TrimEnd('\\')",
  "$kept=@($p -split ';' | Where-Object { $_.Trim().TrimEnd('\\') -ine $t })",
  "$n=$kept -join ';'",
  "if($n -eq $p){exit 3}",
  "[Environment]::SetEnvironmentVariable('Path',$n,'User')",
  "Write-Output (ConvertTo-Json -Compress -InputObject $p)",
].join("; ");

const WINDOWS_PATH_RESTORE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$original=$env:PLANNOTATOR_UNINSTALL_ORIGINAL_PATH",
  "[Environment]::SetEnvironmentVariable('Path',$original,'User')",
].join("; ");

/** @internal Exported only so the Windows worker syntax can be regression-tested. */
export const WINDOWS_SELF_DELETE_SCRIPT = [
  "$target=$env:PLANNOTATOR_UNINSTALL_TARGET",
  "for($i=0;$i -lt 40;$i++){",
  "  Start-Sleep -Milliseconds 250",
  "  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue",
  "  if(-not (Test-Path -LiteralPath $target)){break}",
  "}",
  "$parent=$env:PLANNOTATOR_UNINSTALL_PARENT",
  "if($parent){Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue}",
].join("\n");

const WINDOWS_SELF_DELETE_BOOTSTRAP_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$self=(Get-Process -Id $PID).Path",
  "Start-Process -FilePath $self -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$env:PLANNOTATOR_UNINSTALL_DELETE_SCRIPT) -WindowStyle Hidden",
].join("; ");

type JsonRecord = Record<string, unknown>;

/** Result returned by a host CLI command invoked during uninstall. */
export interface UninstallCommandResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout?: string;
}

/**
 * Platform and process capabilities used by the uninstall application service.
 *
 * Tests provide this boundary explicitly so no test can discover or mutate the
 * developer's real home directory, PATH, plugins, or agent installations.
 */
export interface UninstallEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly dataDir: string;
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly which: (command: string) => string | null;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => Promise<UninstallCommandResult>;
  readonly scheduleWindowsSelfDelete: (
    target: string,
    parent: string | null,
  ) => Promise<boolean>;
}

/** Requested uninstall behavior after CLI confirmation has completed. */
export interface UninstallRequest {
  readonly purge: boolean;
  readonly dryRun: boolean;
}

/** Caller-visible record of completed, planned, preserved, and failed work. */
export interface UninstallResult {
  readonly ok: boolean;
  readonly dataDir: string;
  readonly removed: readonly string[];
  readonly planned: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

type MutableUninstallResult = {
  dataDir: string;
  removed: string[];
  planned: string[];
  preserved: string[];
  warnings: string[];
  errors: string[];
};

type HookCleanupSpec = {
  readonly event: string;
  readonly matcher?: string;
  readonly suffix: "" | "improve-context";
};

type HookCleanupPolicy = {
  readonly allowRelocatedBinary: boolean;
  readonly removeFileWhenEmpty: boolean;
};

type HostCleanupRecovery = {
  readonly manualCleanup: string;
};

type PathIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

type PathIdentityResult =
  | { readonly kind: "found"; readonly identity: PathIdentity }
  | { readonly kind: "missing" }
  | { readonly kind: "error" };

type PathRelation = "same" | "different" | "unknown";

/**
 * Build the real process boundary used by `plannotator uninstall`.
 *
 * No filesystem mutation occurs until `runPlannotatorUninstall` is called.
 */
export function createDefaultUninstallEnvironment(): UninstallEnvironment {
  const homeDir = homedir();
  const env = process.env;

  return {
    platform: process.platform,
    homeDir,
    tempDir: tmpdir(),
    dataDir: getPlannotatorDataDir(),
    execPath: process.execPath,
    env,
    which: (command) => Bun.which(command),
    runCommand: defaultRunCommand,
    scheduleWindowsSelfDelete: defaultScheduleWindowsSelfDelete,
  };
}

/**
 * Explain the irreversible purge boundary in user-facing language.
 */
export function formatPurgeWarning(dataDir: string): string {
  return [
    `Purge will permanently delete Plannotator data in ${dataDir}.`,
    "This data is local-only. It is not stored on a Plannotator server and cannot be recovered after purge.",
  ].join("\n");
}

/**
 * Remove Plannotator's conventional installation and recognizable host
 * integrations. Expected filesystem and host-CLI failures are collected in
 * the returned value so one stale integration cannot prevent other cleanup.
 */
export async function runPlannotatorUninstall(
  request: UninstallRequest,
  environment = createDefaultUninstallEnvironment(),
): Promise<UninstallResult> {
  const state: MutableUninstallResult = {
    dataDir: resolve(environment.dataDir),
    removed: [],
    planned: [],
    preserved: [],
    warnings: [],
    errors: [],
  };

  const initialDataDirIdentity = readPathIdentity(state.dataDir);
  const dataDirSafetyIssue =
    getDataDirSafetyIssue(
      state.dataDir,
      resolve(environment.homeDir),
      resolve(environment.tempDir),
      environment.platform,
    ) ?? inspectDataDir(state.dataDir);

  if (request.purge && dataDirSafetyIssue) {
    return {
      ...state,
      ok: false,
      errors: [
        `Refusing to purge ${state.dataDir}: ${dataDirSafetyIssue}.`,
      ],
    };
  }

  const paths = resolveOwnedPaths(environment);

  await removeHostPlugins(request, environment, paths, state);
  removeHostConfigEntries(request, environment, paths, state);
  removeInstalledFiles(request, environment, paths, state);
  if (dataDirSafetyIssue) {
    state.warnings.push(
      `Preserved managed runtime paths under ${state.dataDir}: ${dataDirSafetyIssue}.`,
    );
  } else {
    const destructiveBoundaryIssue = getDataDirDestructiveBoundaryIssue(
      state.dataDir,
      resolve(environment.homeDir),
      resolve(environment.tempDir),
      environment.platform,
      initialDataDirIdentity,
    );
    if (destructiveBoundaryIssue) {
      state.errors.push(
        `Refusing to remove managed paths under ${state.dataDir}: ${destructiveBoundaryIssue}.`,
      );
    } else {
      // Keep this block synchronous: no host command or other awaited work may
      // reopen a path-swap window after the destructive-boundary revalidation.
      removeInstallerData(request, state);
      if (request.purge) purgeLocalData(request, state);
    }
  }

  if (state.errors.length === 0) {
    await removeBinaries(request, environment, paths, state);
  }
  if (state.errors.length > 0) {
    const hasSpecificRetryWarning = state.warnings.some((warning) =>
      warning.startsWith("The Plannotator CLI remains at "),
    );
    if (!hasSpecificRetryWarning) {
      state.warnings.push(
        "Preserved the Plannotator CLI and its Windows PATH entry so you can resolve the errors and retry uninstall.",
      );
    }
  }

  return {
    ...state,
    ok: state.errors.length === 0,
  };
}

/**
 * Format an uninstall result for terminal output without exposing host command
 * stdout/stderr or unrelated configuration contents.
 */
export function formatUninstallResult(result: UninstallResult): string {
  const lines: string[] = [];

  if (result.removed.length > 0) {
    lines.push("Removed:");
    for (const item of result.removed) lines.push(`  - ${item}`);
  }
  if (result.planned.length > 0) {
    lines.push("Would remove:");
    for (const item of result.planned) lines.push(`  - ${item}`);
  }
  if (result.preserved.length > 0) {
    lines.push("Preserved:");
    for (const item of result.preserved) lines.push(`  - ${item}`);
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const item of result.warnings) lines.push(`  - ${item}`);
  }
  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const item of result.errors) lines.push(`  - ${item}`);
  }

  return lines.join("\n");
}

function formatUninstallRetryCommand(request: UninstallRequest): string {
  return request.purge
    ? "plannotator uninstall --purge"
    : "plannotator uninstall";
}

function reportHostCleanupFailure(
  summary: string,
  problem: string,
  recovery: HostCleanupRecovery,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  state.errors.push(
    `${summary}: ${problem}. Manual cleanup: ${recovery.manualCleanup} Then rerun \`${formatUninstallRetryCommand(request)}\`.`,
  );
}

function resolveOwnedPaths(environment: UninstallEnvironment) {
  const { homeDir, env } = environment;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");
  const codexDir = env.CODEX_HOME || join(homeDir, ".codex");
  const factoryDir = env.FACTORY_CONFIG_DIR || join(homeDir, ".factory");
  const copilotDir = env.COPILOT_HOME || join(homeDir, ".copilot");
  const xdgConfigDir = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  const xdgCacheDir = env.XDG_CACHE_HOME || join(homeDir, ".cache");
  const configDirs = uniquePaths([
    xdgConfigDir,
    join(homeDir, ".config"),
  ]);
  const localAppData = env.LOCALAPPDATA || join(homeDir, "AppData", "Local");
  const unixInstallDir = join(homeDir, ".local", "bin");
  const windowsInstallDir = join(localAppData, "plannotator");

  const binaryPaths = uniquePaths([
    join(unixInstallDir, "plannotator"),
    join(unixInstallDir, "plannotator.exe"),
    join(windowsInstallDir, "plannotator"),
    join(windowsInstallDir, "plannotator.exe"),
  ]);

  return {
    claudeDir,
    codexDir,
    factoryDir,
    copilotDir,
    configDirs,
    xdgCacheDir,
    windowsInstallDir,
    binaryPaths,
  };
}

async function removeHostPlugins(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<void> {
  const actions = [
    {
      label: "Claude Code plugin plannotator@plannotator",
      command: "claude",
      args: [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
        ...(request.purge ? [] : ["--keep-data"]),
        "--yes",
      ],
      installed:
        hasEnabledPlugin(
          join(paths.claudeDir, "settings.json"),
          "plannotator@plannotator",
        ) ||
        hasInstalledPlugin(
          join(paths.claudeDir, "plugins", "installed_plugins.json"),
          "plannotator@plannotator",
        ),
    },
    {
      label: "GitHub Copilot CLI plugin plannotator-copilot@plannotator",
      command: "copilot",
      args: ["plugins", "remove", "plannotator-copilot@plannotator", "--plugin"],
      installed:
        hasEnabledPlugin(
          join(paths.copilotDir, "settings.json"),
          "plannotator-copilot@plannotator",
        ) ||
        hasDirectoryWithPrefix(
          join(paths.copilotDir, "installed-plugins", "plannotator"),
          "plannotator-copilot",
        ),
    },
    {
      label: "Droid plugin plannotator@plannotator",
      command: "droid",
      args: [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
      ],
      installed:
        hasEnabledPlugin(
          join(paths.factoryDir, "settings.json"),
          "plannotator@plannotator",
        ) ||
        hasInstalledPlugin(
          join(paths.factoryDir, "plugins", "installed_plugins.json"),
          "plannotator@plannotator",
        ),
    },
    {
      label: "Pi extension npm:@plannotator/pi-extension",
      command: "pi",
      args: ["remove", "npm:@plannotator/pi-extension"],
      installed: hasPiPackage(
        join(
          environment.env.PI_CODING_AGENT_DIR || join(environment.homeDir, ".pi", "agent"),
          "settings.json",
        ),
      ),
    },
    {
      label: "VS Code extension backnotprop.plannotator-webview",
      command: "code",
      args: ["--uninstall-extension", "backnotprop.plannotator-webview"],
      installed: hasDirectoryWithPrefix(
        join(environment.homeDir, ".vscode", "extensions"),
        "backnotprop.plannotator-webview-",
      ),
    },
  ] as const;

  for (const action of actions) {
    if (!action.installed) continue;
    if (request.dryRun) {
      state.planned.push(action.label);
      continue;
    }

    const executable = environment.which(action.command);
    const manualCommand = [action.command, ...action.args].join(" ");
    if (!executable) {
      state.errors.push(
        `${action.label} was detected but ${action.command} is unavailable; it was not removed. Manual cleanup: restore ${action.command} on PATH and run \`${manualCommand}\`. After it succeeds, rerun \`${formatUninstallRetryCommand(request)}\`.`,
      );
      continue;
    }

    const result = await environment.runCommand(executable, action.args);
    if (result.exitCode === 0) {
      state.removed.push(action.label);
    } else {
      state.errors.push(
        `${action.label} was not removed automatically (${result.timedOut ? "command timed out" : `exit ${result.exitCode}`}). Manual cleanup: run \`${manualCommand}\` directly and resolve the host error until it succeeds. Then rerun \`${formatUninstallRetryCommand(request)}\`.`,
      );
    }
  }
}

function removeHostConfigEntries(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): void {
  cleanupHooksJson(
    join(paths.claudeDir, "settings.json"),
    [
      { event: "PermissionRequest", matcher: "ExitPlanMode", suffix: "" },
      { event: "PreToolUse", matcher: "EnterPlanMode", suffix: "improve-context" },
    ],
    paths.binaryPaths,
    environment.platform,
    {
      allowRelocatedBinary: false,
      removeFileWhenEmpty: false,
    },
    "managed Claude Code hooks",
    `Make ${join(paths.claudeDir, "settings.json")} a readable, writable strict JSON object. Remove only Plannotator command hooks from hooks.PermissionRequest entries whose matcher is "ExitPlanMode" and hooks.PreToolUse entries whose matcher is "EnterPlanMode", then save the file.`,
    request,
    state,
  );

  cleanupHooksJson(
    join(paths.codexDir, "hooks.json"),
    [{ event: "Stop", suffix: "" }],
    paths.binaryPaths,
    environment.platform,
    {
      allowRelocatedBinary: true,
      removeFileWhenEmpty: true,
    },
    "managed Codex Stop hook",
    `Make ${join(paths.codexDir, "hooks.json")} a readable, writable strict JSON object. Remove only Plannotator command hooks from hooks.Stop entries, then save the file; delete it only if no other settings remain.`,
    request,
    state,
  );
  cleanupCodexConfig(
    join(paths.codexDir, "config.toml"),
    request,
    state,
  );

  cleanupGeminiSettings(
    join(environment.homeDir, ".gemini", "settings.json"),
    paths.binaryPaths,
    environment.platform,
    request,
    state,
  );

  for (const configDir of paths.configDirs) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      cleanupOpenCodeConfig(
        join(configDir, "opencode", name),
        request,
        state,
      );
    }
  }
}

function removeInstalledFiles(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): void {
  for (const skill of CORE_SKILLS) {
    removePath(
      join(paths.claudeDir, "skills", skill),
      request,
      state,
    );
    removePath(
      join(environment.homeDir, ".agents", "skills", skill),
      request,
      state,
    );
  }

  for (const skill of STALE_SHARED_SKILLS) {
    removePath(join(paths.claudeDir, "skills", skill), request, state);
    removePath(
      join(environment.homeDir, ".agents", "skills", skill),
      request,
      state,
    );
  }

  cleanupStaleSkillLayout(
    join(paths.claudeDir, "skills", "core"),
    CORE_SKILLS,
    request,
    state,
  );
  cleanupStaleSkillLayout(
    join(paths.claudeDir, "skills", "extra"),
    EXTRA_SKILLS,
    request,
    state,
  );

  for (const skill of STALE_CODEX_SKILLS) {
    removePath(join(paths.codexDir, "skills", skill), request, state);
  }

  for (const skill of KIRO_SKILLS) {
    removePath(
      join(environment.homeDir, ".kiro", "skills", skill),
      request,
      state,
    );
  }

  for (const command of LEGACY_COMMAND_NAMES) {
    removePath(
      join(paths.claudeDir, "commands", `${command}.md`),
      request,
      state,
    );
    for (const configDir of paths.configDirs) {
      removePath(
        join(configDir, "opencode", "commands", `${command}.md`),
        request,
        state,
      );
    }
  }

  for (const command of [
    "plannotator-review",
    "plannotator-annotate",
    "plannotator-last",
  ]) {
    removePath(
      join(environment.homeDir, ".gemini", "commands", `${command}.toml`),
      request,
      state,
    );
  }

  removePath(
    join(environment.homeDir, ".gemini", "policies", "plannotator.toml"),
    request,
    state,
  );

  cleanupRecognizableKiroAgent(
    join(environment.homeDir, ".kiro", "agents", "plannotator.json"),
    request,
    state,
  );
  for (const configDir of paths.configDirs) {
    cleanupRecognizableAmpPlugin(
      join(configDir, "amp", "plugins", "plannotator.ts"),
      request,
      state,
    );
  }

  for (const cachePath of [
    join(
      paths.xdgCacheDir,
      "opencode",
      "node_modules",
      "@plannotator",
      "opencode",
    ),
    join(
      paths.xdgCacheDir,
      "opencode",
      "packages",
      "@plannotator",
      "opencode",
    ),
    join(
      environment.homeDir,
      ".cache",
      "opencode",
      "node_modules",
      "@plannotator",
      "opencode",
    ),
    join(
      environment.homeDir,
      ".cache",
      "opencode",
      "packages",
      "@plannotator",
      "opencode",
    ),
  ]) {
    removePath(cachePath, request, state);
  }

  cleanupDirectoryEntriesWithPrefix(
    join(environment.homeDir, ".bun", "install", "cache", "@plannotator"),
    "opencode",
    request,
    state,
  );
}

function removeInstallerData(
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  // The sidecars are installed components. install-prefs and migrations are
  // retained as local state in the default mode: the migration ledger is what
  // prevents a later reinstall from mistaking separately installed extras for
  // obsolete installer copies. Purge removes those files through its inventory.
  const sidecarPaths = [
    join(state.dataDir, "vendor", "sem"),
    join(state.dataDir, "vendor", "agent-terminal"),
    join(state.dataDir, "vendor", "call-flow"),
  ];
  const hadManagedSidecar = sidecarPaths.some(pathExists);
  for (const path of sidecarPaths) {
    removePath(path, request, state);
  }
  if (hadManagedSidecar) {
    removeEmptyOwnedParent(
      join(state.dataDir, "vendor"),
      ["sem", "agent-terminal", "call-flow"],
      request,
      state,
    );
  }
}

function purgeLocalData(
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!pathExists(state.dataDir)) return;

  for (const name of PURGE_OWNED_TOP_LEVEL) {
    removePath(join(state.dataDir, name), request, state);
  }

  let remaining: string[];
  try {
    remaining = readdirSync(state.dataDir);
  } catch (error) {
    if (existsSync(state.dataDir)) {
      state.errors.push(
        `Could not inspect ${state.dataDir} after purge: ${formatError(error)}`,
      );
    }
    return;
  }

  if (request.dryRun) {
    const recognized = new Set<string>(PURGE_OWNED_TOP_LEVEL);
    const customEntries = remaining.filter(
      (name) =>
        !recognized.has(name) &&
        !(
          name === "vendor" &&
          directoryContainsOnly(
            join(state.dataDir, "vendor"),
            ["sem", "agent-terminal", "call-flow"],
          )
        ),
    );
    if (customEntries.length === 0) {
      state.planned.push(state.dataDir);
      return;
    }
    for (const name of customEntries) {
      state.preserved.push(
        `${join(state.dataDir, name)} (unrecognized custom entry)`,
      );
    }
    return;
  }

  if (remaining.length === 0) {
    removePath(state.dataDir, request, state);
    return;
  }

  const recognized = new Set<string>(PURGE_OWNED_TOP_LEVEL);
  for (const name of remaining) {
    const remainingPath = join(state.dataDir, name);
    if (recognized.has(name)) {
      state.errors.push(
        `Known Plannotator data entry remains after purge: ${remainingPath}.`,
      );
    } else {
      state.preserved.push(
        `${remainingPath} (unrecognized custom entry)`,
      );
    }
  }
}

async function removeWindowsPathEntry(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<string | null> {
  if (environment.platform !== "win32") return null;

  const label = `Windows user PATH entry ${paths.windowsInstallDir}`;
  if (request.dryRun) {
    state.planned.push(label);
    return null;
  }

  const powershell =
    environment.which("powershell.exe") ||
    environment.which("pwsh.exe");
  if (!powershell) {
    state.errors.push(
      `Could not inspect the Windows user PATH; remove ${paths.windowsInstallDir} from PATH manually if present.`,
    );
    return null;
  }

  const result = await environment.runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT],
    { PLANNOTATOR_UNINSTALL_PATH: paths.windowsInstallDir },
  );
  if (result.exitCode === 0) {
    state.removed.push(label);
    try {
      const originalPath: unknown = JSON.parse(result.stdout?.trim() ?? "");
      if (typeof originalPath !== "string") throw new Error("not a string");
      return originalPath;
    } catch {
      state.errors.push(
        `Removed ${paths.windowsInstallDir} from the Windows user PATH but could not capture the original PATH for safe rollback.`,
      );
      state.warnings.push(
        `The Plannotator CLI remains at ${environment.execPath}, but its Windows PATH entry was removed without a usable backup. Run that full path to retry, then restore PATH manually if needed.`,
      );
    }
  } else if (result.exitCode !== 3) {
    state.errors.push(
      `Could not remove ${paths.windowsInstallDir} from the Windows user PATH.`,
    );
  }
  return null;
}

async function removeBinaries(
  request: UninstallRequest,
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  state: MutableUninstallResult,
): Promise<void> {
  const existingBinaryPaths = paths.binaryPaths.filter(pathExists);
  const currentBinary = existingBinaryPaths.find((binaryPath) =>
    pathsReferToSameEntry(
      binaryPath,
      environment.execPath,
      environment.platform,
    ),
  );
  const inactiveBinaries = existingBinaryPaths.filter(
    (binaryPath) => binaryPath !== currentBinary,
  );

  for (const binaryPath of inactiveBinaries) {
    if (request.dryRun) {
      state.planned.push(binaryPath);
      continue;
    }
    removePath(binaryPath, request, state);
    if (state.errors.length > 0) return;
  }

  const originalWindowsPath = await removeWindowsPathEntry(
    request,
    environment,
    paths,
    state,
  );
  if (state.errors.length > 0 || !currentBinary) return;

  if (request.dryRun) {
    state.planned.push(currentBinary);
    return;
  }

  if (environment.platform === "win32") {
    const scheduled = await environment.scheduleWindowsSelfDelete(
      currentBinary,
      pathsReferToSameEntry(
        dirname(currentBinary),
        paths.windowsInstallDir,
        environment.platform,
      )
        ? paths.windowsInstallDir
        : null,
    );
    if (scheduled) {
      state.removed.push(`${currentBinary} (scheduled after exit)`);
    } else {
      state.errors.push(
        `Could not schedule removal of the running executable ${currentBinary}.`,
      );
      if (originalWindowsPath !== null) {
        await restoreWindowsPathEntry(
          environment,
          paths,
          originalWindowsPath,
          state,
        );
      }
    }
    return;
  }

  removePath(currentBinary, request, state);
}

async function restoreWindowsPathEntry(
  environment: UninstallEnvironment,
  paths: ReturnType<typeof resolveOwnedPaths>,
  originalPath: string,
  state: MutableUninstallResult,
): Promise<void> {
  const powershell =
    environment.which("powershell.exe") ||
    environment.which("pwsh.exe");
  if (!powershell) return;

  const result = await environment.runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_RESTORE_SCRIPT],
    { PLANNOTATOR_UNINSTALL_ORIGINAL_PATH: originalPath },
  );
  if (result.exitCode !== 0) {
    state.errors.push(
      `Could not restore ${paths.windowsInstallDir} to the Windows user PATH after self-delete scheduling failed.`,
    );
    state.warnings.push(
      `The Plannotator CLI remains at ${environment.execPath}, but its Windows PATH entry could not be restored. Run that full path to retry, then restore PATH manually if needed.`,
    );
    return;
  }

  const label = `Windows user PATH entry ${paths.windowsInstallDir}`;
  const removedIndex = state.removed.indexOf(label);
  if (removedIndex >= 0) state.removed.splice(removedIndex, 1);
  state.preserved.push(`${label} (restored for retry)`);
}

function cleanupHooksJson(
  filePath: string,
  specs: readonly HookCleanupSpec[],
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  policy: HookCleanupPolicy,
  label: string,
  manualCleanup: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const recovery = { manualCleanup };
  const parsed = readJsonRecord(
    filePath,
    label,
    recovery,
    request,
    state,
  );
  if (!parsed) return;

  const hooks = asRecord(parsed.hooks);
  if (!hooks) return;

  let changed = false;
  for (const spec of specs) {
    const entries = hooks[spec.event];
    if (!Array.isArray(entries)) continue;

    const nextEntries: unknown[] = [];
    let eventChanged = false;
    for (const value of entries) {
      const entry = asRecord(value);
      if (
        !entry ||
        (spec.matcher !== undefined && entry.matcher !== spec.matcher)
      ) {
        nextEntries.push(value);
        continue;
      }

      const hookEntries = entry.hooks;
      if (!Array.isArray(hookEntries)) {
        nextEntries.push(value);
        continue;
      }

      const nextHooks = hookEntries.filter(
        (hook) =>
          !isManagedHook(
            hook,
            binaryPaths,
            spec.suffix,
            platform,
            policy.allowRelocatedBinary,
          ),
      );
      if (nextHooks.length === hookEntries.length) {
        nextEntries.push(value);
        continue;
      }

      changed = true;
      eventChanged = true;
      if (nextHooks.length === 0 && hasOnlyKeys(entry, ["matcher", "hooks"])) {
        continue;
      }
      nextEntries.push({ ...entry, hooks: nextHooks });
    }

    if (!eventChanged) continue;
    if (nextEntries.length === 0) delete hooks[spec.event];
    else hooks[spec.event] = nextEntries;
  }

  if (!changed) return;
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  else parsed.hooks = hooks;

  if (request.dryRun) {
    state.planned.push(`${label} in ${filePath}`);
    return;
  }

  if (policy.removeFileWhenEmpty && Object.keys(parsed).length === 0) {
    removePath(filePath, request, state, recovery);
    return;
  }

  writeJson(filePath, parsed, label, recovery, request, state);
}

function cleanupCodexConfig(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!existsSync(filePath)) return;
  const recovery = {
    manualCleanup: `Make ${filePath} readable and writable. If its only nonblank lines are [features] and hooks = true, delete the file; otherwise leave its custom content in place.`,
  };
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    reportHostCleanupFailure(
      `Could not inspect ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
    return;
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const isInstallerTemplate =
    meaningfulLines.length === 2 &&
    meaningfulLines[0] === "[features]" &&
    /^hooks\s*=\s*true$/.test(meaningfulLines[1]);

  if (!isInstallerTemplate) return;
  removePath(filePath, request, state, recovery);
}

function cleanupGeminiSettings(
  filePath: string,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const recovery = {
    manualCleanup: `Make ${filePath} a readable, writable strict JSON object. Remove only Plannotator command hooks from hooks.BeforeTool entries whose matcher is "exit_plan_mode", then save the file.`,
  };
  const parsed = readJsonRecord(
    filePath,
    "managed Gemini hooks",
    recovery,
    request,
    state,
  );
  if (!parsed) return;
  const wasInstallerTemplate = isGeminiInstallerTemplate(
    parsed,
    binaryPaths,
    platform,
  );

  const hooks = asRecord(parsed.hooks);
  const beforeTool = hooks?.BeforeTool;
  if (!hooks || !Array.isArray(beforeTool)) return;

  let changed = false;
  const nextEntries: unknown[] = [];
  for (const value of beforeTool) {
    const entry = asRecord(value);
    if (
      !entry ||
      entry.matcher !== "exit_plan_mode" ||
      !Array.isArray(entry.hooks)
    ) {
      nextEntries.push(value);
      continue;
    }

    const nextHooks = entry.hooks.filter(
      (hook) => !isManagedHook(hook, binaryPaths, "", platform),
    );
    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(value);
      continue;
    }

    changed = true;
    if (nextHooks.length === 0 && hasOnlyKeys(entry, ["matcher", "hooks"])) {
      continue;
    }
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  if (!changed) return;
  if (request.dryRun) {
    state.planned.push(`managed Gemini hook in ${filePath}`);
    return;
  }

  if (wasInstallerTemplate) {
    removePath(filePath, request, state, recovery);
    return;
  }

  if (nextEntries.length === 0) delete hooks.BeforeTool;
  else hooks.BeforeTool = nextEntries;
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  else parsed.hooks = hooks;
  writeJson(
    filePath,
    parsed,
    "managed Gemini hook",
    recovery,
    request,
    state,
  );
}

function cleanupOpenCodeConfig(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!existsSync(filePath)) return;
  const recovery = {
    manualCleanup: `Make ${filePath} readable, writable, and valid JSON or JSONC. Remove every plugin array entry for @plannotator/opencode, including versioned entries and tuple entries, then save the file.`,
  };

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    reportHostCleanupFailure(
      `Could not inspect ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
    return;
  }

  const parseErrors: ParseError[] = [];
  const parsedValue: unknown = parseJsonc(content, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const parsed = asRecord(parsedValue);
  if (parseErrors.length > 0 || !parsed) {
    reportMalformedSharedConfig(
      filePath,
      "it is not valid JSON or JSONC",
      "@plannotator/opencode plugin entries",
      recovery,
      request,
      state,
    );
    return;
  }
  if (!Array.isArray(parsed.plugin)) return;

  const matchingIndexes = parsed.plugin
    .map((entry, index) =>
      isPlannotatorOpenCodePlugin(entry) ? index : -1,
    )
    .filter((index) => index >= 0)
    .reverse();
  if (matchingIndexes.length === 0) return;

  if (request.dryRun) {
    state.planned.push(`@plannotator/opencode entry in ${filePath}`);
    return;
  }

  let updated = content;
  for (const index of matchingIndexes) {
    updated = removeJsoncArrayEntry(updated, ["plugin"], index);
  }
  writeTextUpdate(
    filePath,
    updated,
    "@plannotator/opencode entry",
    recovery,
    request,
    state,
  );
}

function removeJsoncArrayEntry(
  content: string,
  path: (string | number)[],
  index: number,
): string {
  const tree = parseTree(content, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const arrayNode = tree ? findNodeAtLocation(tree, path) : undefined;
  const children = arrayNode?.type === "array" ? arrayNode.children : undefined;
  const target = children?.[index];
  if (!arrayNode || !children || !target) return content;

  const targetEnd = target.offset + target.length;
  const next = children[index + 1];
  let commaOffset = findJsoncCommaOffset(
    content,
    targetEnd,
    next?.offset ?? arrayNode.offset + arrayNode.length,
  );
  if (commaOffset === null && index > 0) {
    const previous = children[index - 1];
    if (previous) {
      commaOffset = findJsoncCommaOffset(
        content,
        previous.offset + previous.length,
        target.offset,
      );
    }
  }

  const edits = [
    { offset: target.offset, length: target.length, content: "" },
  ];
  if (commaOffset !== null) {
    edits.push({ offset: commaOffset, length: 1, content: "" });
  }
  return applyEdits(content, edits);
}

function findJsoncCommaOffset(
  content: string,
  start: number,
  end: number,
): number | null {
  const segment = content.slice(start, end);
  const scanner = createScanner(segment, false);
  while (scanner.getPosition() < segment.length) {
    scanner.scan();
    if (
      scanner.getTokenLength() === 1 &&
      segment[scanner.getTokenOffset()] === ","
    ) {
      return start + scanner.getTokenOffset();
    }
  }
  return null;
}

function cleanupRecognizableKiroAgent(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  const recovery = {
    manualCleanup: `Make ${filePath} a readable, writable strict JSON object without changing its intent. If it is the installer-provided Plannotator Kiro agent, delete it; otherwise keep the repaired custom agent at that path.`,
  };
  const parsed = readJsonRecord(
    filePath,
    "the Plannotator Kiro agent",
    recovery,
    request,
    state,
  );
  if (!parsed) return;

  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  const description =
    typeof parsed.description === "string" ? parsed.description : "";
  const recognizable =
    parsed.name === "plannotator" &&
    description.includes("Kiro custom agent wiring for Plannotator") &&
    prompt.includes("Each skill runs a `plannotator` shell command");

  if (recognizable) {
    removePath(filePath, request, state, recovery);
  } else {
    state.preserved.push(`${filePath} (custom or unrecognized Kiro agent)`);
  }
}

function cleanupRecognizableAmpPlugin(
  filePath: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  if (!existsSync(filePath)) return;
  const recovery = {
    manualCleanup: `Make ${filePath} readable and writable. If it contains the installer-provided Plannotator Amp plugin, delete it; otherwise keep the custom plugin at that path.`,
  };
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    reportHostCleanupFailure(
      `Could not inspect ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
    return;
  }

  const recognizable =
    content.includes('const CATEGORY = "Plannotator"') &&
    content.includes("export default function plannotatorAmpPlugin") &&
    content.includes("PLANNOTATOR_ORIGIN");

  if (recognizable) {
    removePath(filePath, request, state, recovery);
  } else {
    state.preserved.push(`${filePath} (custom or unrecognized Amp plugin)`);
  }
}

function readJsonRecord(
  filePath: string,
  integration: string,
  recovery: HostCleanupRecovery,
  request: UninstallRequest,
  state: MutableUninstallResult,
): JsonRecord | null {
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    reportHostCleanupFailure(
      `Could not inspect ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    const record = asRecord(parsed);
    if (!record) {
      reportMalformedSharedConfig(
        filePath,
        "it is not a JSON object",
        integration,
        recovery,
        request,
        state,
      );
      return null;
    }
    return record;
  } catch {
    reportMalformedSharedConfig(
      filePath,
      "it is not strict JSON",
      integration,
      recovery,
      request,
      state,
    );
    return null;
  }
}

function reportMalformedSharedConfig(
  filePath: string,
  reason: string,
  integration: string,
  recovery: HostCleanupRecovery,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  reportHostCleanupFailure(
    `Preserved ${filePath}`,
    `${reason}, so ${integration} cannot be classified safely`,
    recovery,
    request,
    state,
  );
}

function writeJson(
  filePath: string,
  value: JsonRecord,
  label: string,
  recovery: HostCleanupRecovery,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  try {
    const original = readFileSync(filePath, "utf8");
    const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
    const indentation = original.match(/\r?\n([\t ]+)\S/)?.[1];
    const trailingNewline = /\r?\n$/.test(original);
    const serialized = JSON.stringify(value, null, indentation)
      .replace(/\n/g, lineEnding);
    writeFileSync(
      filePath,
      `${serialized}${trailingNewline ? lineEnding : ""}`,
      "utf8",
    );
    state.removed.push(`${label} in ${filePath}`);
  } catch (error) {
    reportHostCleanupFailure(
      `Could not update ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
  }
}

function writeTextUpdate(
  filePath: string,
  content: string,
  label: string,
  recovery: HostCleanupRecovery,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  try {
    writeFileSync(filePath, content, "utf8");
    state.removed.push(`${label} in ${filePath}`);
  } catch (error) {
    reportHostCleanupFailure(
      `Could not update ${filePath}`,
      formatError(error),
      recovery,
      request,
      state,
    );
  }
}

function cleanupStaleSkillLayout(
  directory: string,
  managedSkills: readonly string[],
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      state.preserved.push(`${directory} (custom or unrecognized skill layout)`);
      return;
    }
    entries = readdirSync(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    state.errors.push(`Could not inspect ${directory}: ${formatError(error)}`);
    return;
  }

  const managed = new Set(managedSkills);
  const managedEntries = entries.filter((entry) => managed.has(entry));
  if (managedEntries.length === 0) return;

  for (const entry of managedEntries) {
    removePath(join(directory, entry), request, state);
  }

  const customEntries = entries.filter((entry) => !managed.has(entry));
  for (const entry of customEntries) {
    state.preserved.push(
      `${join(directory, entry)} (custom or unrecognized skill layout entry)`,
    );
  }

  if (customEntries.length === 0) {
    removeEmptyOwnedParent(directory, managedSkills, request, state);
  }
}

function cleanupDirectoryEntriesWithPrefix(
  directory: string,
  prefix: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    entries = readdirSync(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    state.errors.push(`Could not inspect ${directory}: ${formatError(error)}`);
    return;
  }

  for (const entry of entries) {
    if (entry === prefix || entry.startsWith(`${prefix}@`)) {
      removePath(join(directory, entry), request, state);
    }
  }
}

function directoryContainsOnly(
  directory: string,
  allowedEntries: readonly string[],
): boolean {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const allowed = new Set(allowedEntries);
    const entries = readdirSync(directory);
    return (
      entries.length > 0 &&
      entries.every((entry) => allowed.has(entry))
    );
  } catch {
    return false;
  }
}

function removeEmptyOwnedParent(
  directory: string,
  plannedChildren: readonly string[],
  request: UninstallRequest,
  state: MutableUninstallResult,
): void {
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    entries = readdirSync(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    state.errors.push(`Could not inspect ${directory}: ${formatError(error)}`);
    return;
  }

  if (request.dryRun) {
    const planned = new Set(plannedChildren);
    if (!entries.every((entry) => planned.has(entry))) return;
  } else if (entries.length > 0) {
    return;
  }
  removePath(directory, request, state);
}

function removePath(
  path: string,
  request: UninstallRequest,
  state: MutableUninstallResult,
  recovery?: HostCleanupRecovery,
): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    if (recovery) {
      reportHostCleanupFailure(
        `Could not inspect ${path}`,
        formatError(error),
        recovery,
        request,
        state,
      );
    } else {
      state.errors.push(`Could not inspect ${path}: ${formatError(error)}`);
    }
    return;
  }

  if (request.dryRun) {
    state.planned.push(path);
    return;
  }

  try {
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      // Never route a symlink through recursive removal. Unlinking the directory
      // entry also gives hardlinked files the intended target-preserving behavior.
      unlinkSync(path);
    }
    state.removed.push(path);
  } catch (error) {
    if (recovery) {
      reportHostCleanupFailure(
        `Could not remove ${path}`,
        formatError(error),
        recovery,
        request,
        state,
      );
    } else {
      state.errors.push(`Could not remove ${path}: ${formatError(error)}`);
    }
  }
}

function isManagedHook(
  value: unknown,
  binaryPaths: readonly string[],
  suffix: "" | "improve-context",
  platform: NodeJS.Platform,
  allowRelocatedBinary = false,
): boolean {
  const hook = asRecord(value);
  if (!hook || hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }

  const command = hook.command.trim();
  const expectedBare = suffix ? `plannotator ${suffix}` : "plannotator";
  if (command === expectedBare) return true;

  for (const binaryPath of binaryPaths) {
    const candidates = suffix
      ? [`${binaryPath} ${suffix}`, `"${binaryPath}" ${suffix}`]
      : [binaryPath, `"${binaryPath}"`];
    if (candidates.some((candidate) => sameCommand(command, candidate, platform))) {
      return true;
    }
  }
  return allowRelocatedBinary && isRelocatedPlannotatorCommand(command, suffix);
}

function isRelocatedPlannotatorCommand(
  command: string,
  suffix: "" | "improve-context",
): boolean {
  const commandSuffix = suffix ? ` ${suffix}` : "";
  if (commandSuffix && !command.endsWith(commandSuffix)) return false;

  const executable = commandSuffix
    ? command.slice(0, -commandSuffix.length).trim()
    : command;
  const unquoted =
    executable.length >= 2 &&
      executable.startsWith('"') &&
      executable.endsWith('"')
      ? executable.slice(1, -1)
      : executable;
  if (!isAbsolute(unquoted)) return false;

  const executableName = basename(unquoted).toLowerCase();
  return executableName === "plannotator" || executableName === "plannotator.exe";
}

function isGeminiInstallerTemplate(
  value: JsonRecord,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const hooks = asRecord(value.hooks);
  const experimental = asRecord(value.experimental);
  if (!hooks || !experimental || experimental.plan !== true) return false;
  if (!hasOnlyKeys(value, ["hooks", "experimental"])) return false;
  if (!hasOnlyKeys(experimental, ["plan"])) return false;

  const beforeTool = hooks.BeforeTool;
  if (
    !hasOnlyKeys(hooks, ["BeforeTool"]) ||
    !Array.isArray(beforeTool) ||
    beforeTool.length !== 1
  ) {
    return false;
  }

  const entry = asRecord(beforeTool[0]);
  if (
    !entry ||
    entry.matcher !== "exit_plan_mode" ||
    !hasOnlyKeys(entry, ["matcher", "hooks"]) ||
    !Array.isArray(entry.hooks) ||
    entry.hooks.length !== 1
  ) {
    return false;
  }

  const hook = asRecord(entry.hooks[0]);
  return (
    hook !== null &&
    hasOnlyKeys(hook, ["type", "command", "timeout"]) &&
    isManagedHook(hook, binaryPaths, "", platform)
  );
}

function isPlannotatorOpenCodePlugin(value: unknown): boolean {
  const spec =
    typeof value === "string"
      ? value
      : Array.isArray(value) && typeof value[0] === "string"
        ? value[0]
        : null;
  return spec !== null && /^@plannotator\/opencode(?:@|$)/.test(spec);
}

function hasEnabledPlugin(filePath: string, pluginId: string): boolean {
  const parsed = tryReadJsonRecord(filePath);
  const enabled = parsed ? asRecord(parsed.enabledPlugins) : null;
  return enabled?.[pluginId] === true;
}

function hasInstalledPlugin(filePath: string, pluginId: string): boolean {
  const parsed = tryReadJsonRecord(filePath);
  const plugins = parsed ? asRecord(parsed.plugins) : null;
  const installs = plugins?.[pluginId];
  return Array.isArray(installs) && installs.length > 0;
}

function hasPiPackage(filePath: string): boolean {
  const parsed = tryReadJsonRecord(filePath);
  const packages = parsed?.packages;
  if (!Array.isArray(packages)) return false;

  return packages.some((entry) => {
    const record = asRecord(entry);
    const source =
      typeof entry === "string"
        ? entry
        : typeof record?.source === "string"
          ? record.source
          : null;
    return (
      typeof source === "string" &&
      /^npm:@plannotator\/pi-extension(?:@|$)/.test(source)
    );
  });
}

function tryReadJsonRecord(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function hasDirectoryWithPrefix(directory: string, prefix: string): boolean {
  try {
    return readdirSync(directory).some((entry) => entry.startsWith(prefix));
  } catch {
    return false;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasOnlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sameCommand(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = left.replace(/\\/g, "/");
  const normalizedRight = right.replace(/\\/g, "/");
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameLexicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathsReferToSameEntry(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return comparePathEntries(left, right, platform) === "same";
}

function comparePathEntries(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): PathRelation {
  // The lexical check is the conservative fallback for missing paths and also
  // preserves Windows path semantics in cross-platform tests. Existing aliases
  // are compared by filesystem identity so case, links, and mounts cannot hide
  // that two spellings refer to the same entry.
  if (sameLexicalPath(left, right, platform)) return "same";

  const leftIdentity = readPathIdentity(left);
  const rightIdentity = readPathIdentity(right);
  if (leftIdentity.kind === "error" || rightIdentity.kind === "error") {
    return "unknown";
  }
  if (leftIdentity.kind !== "found" || rightIdentity.kind !== "found") {
    return "different";
  }
  return sameIdentity(leftIdentity.identity, rightIdentity.identity)
    ? "same"
    : "different";
}

function readPathIdentity(path: string): PathIdentityResult {
  try {
    const stat = statSync(path, { bigint: true });
    return {
      kind: "found",
      identity: { device: stat.dev, inode: stat.ino },
    };
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "missing" };
    return { kind: "error" };
  }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalize(resolve(path))))];
}

function getDataDirSafetyIssue(
  dataDir: string,
  homeDir: string,
  tempDir: string,
  platform: NodeJS.Platform,
): string | null {
  if (!isAbsolute(dataDir)) {
    return "the data directory is not absolute";
  }
  const root = parse(dataDir).root;
  const rootRelation = comparePathEntries(dataDir, root, platform);
  if (rootRelation === "same") {
    return "the data directory is a filesystem root";
  }
  if (rootRelation === "unknown") {
    return "the data directory identity relative to the filesystem root could not be verified";
  }

  const homeRelation = comparePathEntries(dataDir, homeDir, platform);
  if (homeRelation === "same") {
    return "the data directory is the home directory; choose a dedicated PLANNOTATOR_DATA_DIR";
  }
  if (homeRelation === "unknown") {
    return "the data directory identity relative to the home directory could not be verified";
  }

  const ancestorRelation = compareAncestorRelation(
    dataDir,
    homeDir,
    platform,
  );
  if (ancestorRelation === "same") {
    return `the data directory contains the home directory ${homeDir}`;
  }
  if (ancestorRelation === "unknown") {
    return "whether the data directory contains the home directory could not be verified";
  }

  const tempRelation = comparePathEntries(dataDir, tempDir, platform);
  if (tempRelation === "same") {
    return "the data directory is the shared temporary directory";
  }
  if (tempRelation === "unknown") {
    return "the data directory identity relative to the shared temporary directory could not be verified";
  }
  return null;
}

function getDataDirDestructiveBoundaryIssue(
  dataDir: string,
  homeDir: string,
  tempDir: string,
  platform: NodeJS.Platform,
  initialIdentity: PathIdentityResult,
): string | null {
  const currentSafetyIssue =
    getDataDirSafetyIssue(dataDir, homeDir, tempDir, platform) ??
    inspectDataDir(dataDir);
  if (currentSafetyIssue) {
    return `the data directory changed after initial validation (${currentSafetyIssue})`;
  }

  const currentIdentity = readPathIdentity(dataDir);
  if (
    initialIdentity.kind === "error" ||
    currentIdentity.kind === "error"
  ) {
    return "the data directory identity could not be revalidated after host cleanup";
  }
  if (initialIdentity.kind !== currentIdentity.kind) {
    return "the data directory changed after initial validation";
  }
  if (
    initialIdentity.kind === "found" &&
    currentIdentity.kind === "found" &&
    !sameIdentity(initialIdentity.identity, currentIdentity.identity)
  ) {
    return "the data directory changed after initial validation";
  }
  return null;
}

function inspectDataDir(dataDir: string): string | null {
  try {
    const stat = lstatSync(dataDir);
    if (stat.isSymbolicLink()) {
      return "the data directory is a symlink; set PLANNOTATOR_DATA_DIR to its resolved target and retry";
    }
    if (!stat.isDirectory()) {
      return "the data path is not a directory";
    }
  } catch (error) {
    if (isMissingPathError(error)) return null;
    return `the data directory could not be inspected (${formatError(error)})`;
  }
  return null;
}

function compareAncestorRelation(
  parent: string,
  child: string,
  platform: NodeJS.Platform,
): PathRelation {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const rel = platform === "win32"
    ? relative(resolvedParent.toLowerCase(), resolvedChild.toLowerCase())
    : relative(resolvedParent, resolvedChild);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return "same";
  }

  const parentIdentity = readPathIdentity(resolvedParent);
  if (parentIdentity.kind === "error") return "unknown";
  if (parentIdentity.kind === "missing") return "different";

  // A string-relative check cannot recognize a case alias, bind mount, or
  // symlinked parent. Walk the existing child's ancestors and compare their
  // device/inode pairs with the proposed purge root instead.
  let current = resolvedChild;
  while (true) {
    const currentIdentity = readPathIdentity(current);
    if (currentIdentity.kind === "error") return "unknown";
    if (
      currentIdentity.kind === "found" &&
      sameIdentity(parentIdentity.identity, currentIdentity.identity)
    ) {
      return "same";
    }

    const next = dirname(current);
    if (next === current) return "different";
    current = next;
  }
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<UninstallCommandResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...env },
    });
  } catch {
    return { exitCode: 1, timedOut: false };
  }

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolveTimeout) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolveTimeout(124);
    }, 15_000);
  });
  const exitCode = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);
  return { exitCode, timedOut, stdout: await stdoutPromise };
}

async function defaultScheduleWindowsSelfDelete(
  target: string,
  parent: string | null,
): Promise<boolean> {
  const powershell = Bun.which("powershell.exe") || Bun.which("pwsh.exe");
  if (!powershell) return false;

  try {
    const proc = Bun.spawn(
      [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_SELF_DELETE_BOOTSTRAP_SCRIPT,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          PLANNOTATOR_UNINSTALL_TARGET: target,
          PLANNOTATOR_UNINSTALL_PARENT: parent ?? "",
          PLANNOTATOR_UNINSTALL_DELETE_SCRIPT: Buffer.from(
            WINDOWS_SELF_DELETE_SCRIPT,
            "utf16le",
          ).toString("base64"),
        },
      },
    );
    return await proc.exited === 0;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
