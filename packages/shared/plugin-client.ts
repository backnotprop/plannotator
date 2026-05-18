import {
  discoverPlannotatorBinaryCandidates,
  discoverInstalledPlannotatorBinary,
  findPlannotatorSourceRoot,
  getOfficialInstallerCommand,
  isCompatiblePluginBinary,
  parsePluginCapabilities,
  shouldAutoInstallPlannotator,
  type PluginBinaryDiscoveryOptions,
  type PluginBinarySource,
} from "./plugin-binary";
import {
  createPluginErrorResponse,
  parsePluginResponse,
  type PluginCapabilities,
  type PluginAnnotateRequest,
  type PluginAnnotateResult,
  type PluginArchiveRequest,
  type PluginArchiveResult,
  type PluginPlanRequest,
  type PluginPlanResult,
  type PluginResponse,
  type PluginReviewRequest,
  type PluginReviewResult,
  type PluginSessionInfo,
  type PluginFeature,
} from "./plugin-protocol";
import { spawn, spawnSync } from "node:child_process";

export { findPlannotatorSourceRoot };

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CommandRunOptions {
  timeoutMs?: number | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSession?: (session: PluginSessionInfo) => void;
  signal?: AbortSignal;
}

export type CommandRunner = (
  command: string,
  args: string[],
  input?: string,
  options?: CommandRunOptions,
) => CommandResult;

export type PluginCommandRunner = (
  command: string,
  args: string[],
  input?: string,
  options?: CommandRunOptions,
) => CommandResult | Promise<CommandResult>;

export interface EnsurePlannotatorBinaryOptions extends PluginBinaryDiscoveryOptions {
  run?: CommandRunner;
  requiredFeatures?: readonly PluginFeature[];
  capabilityTimeoutMs?: number | null;
  installVersion?: string | null;
}

export type EnsurePlannotatorBinaryResult =
  | {
      ok: true;
      path: string;
      source: PluginBinarySource;
      installed: boolean;
      capabilities: PluginCapabilities;
    }
  | {
      ok: false;
      code: string;
      message: string;
      checked: string[];
    };

const SESSION_READY_PREFIX = "PLANNOTATOR_SESSION_READY ";
const DEFAULT_CAPABILITY_TIMEOUT_MS = 5_000;

function hasTimeout(timeoutMs: number | null | undefined): timeoutMs is number {
  return timeoutMs !== null && timeoutMs !== undefined;
}

function hasWindowsShellMetachar(value: string): boolean {
  return /[&|<>^%!]/.test(value);
}

function shouldUseShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

export function unsafeWindowsShellInvocationError(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!shouldUseShell(command, platform)) return undefined;
  const unsafeValue = [command, ...args].find(hasWindowsShellMetachar);
  if (!unsafeValue) return undefined;
  return `Refusing to execute Windows command wrapper with shell metacharacters in the path or arguments: ${unsafeValue}`;
}

function handleSessionReadyLine(line: string, options: CommandRunOptions): void {
  try {
    const session = JSON.parse(line.slice(SESSION_READY_PREFIX.length)) as PluginSessionInfo;
    if (options.onSession) {
      options.onSession(session);
    } else {
      process.stderr.write(`[Plannotator] ${session.url}\n`);
    }
  } catch {
    // Ignore malformed progress lines; final stdout still decides command success.
  }
}

function defaultRunner(
  command: string,
  args: string[],
  input?: string,
  options: CommandRunOptions = {},
): CommandResult {
  const shellError = unsafeWindowsShellInvocationError(command, args);
  if (shellError) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: shellError,
    };
  }

  const result = spawnSync(command, args, {
    encoding: "utf-8",
    input,
    cwd: options.cwd,
    env: options.env,
    shell: shouldUseShell(command),
    ...(hasTimeout(options.timeoutMs) ? { timeout: options.timeoutMs } : {}),
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function defaultPluginRunner(
  command: string,
  args: string[],
  input?: string,
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const shellError = unsafeWindowsShellInvocationError(command, args);
    if (shellError) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        error: shellError,
      });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: shouldUseShell(command),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingStderr = "";
    const terminateChild = (reason: "timeout" | "abort") => {
      if (settled || timedOut || aborted) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref?.();
    };
    const timeoutTimer = hasTimeout(options.timeoutMs)
      ? setTimeout(() => terminateChild("timeout"), options.timeoutMs)
      : undefined;
    timeoutTimer?.unref?.();
    const abortHandler = () => terminateChild("abort");
    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };
    const flushPendingStderr = () => {
      if (!pendingStderr) return;
      if (pendingStderr.startsWith(SESSION_READY_PREFIX)) {
        handleSessionReadyLine(pendingStderr, options);
      } else {
        process.stderr.write(pendingStderr);
        stderrChunks.push(Buffer.from(pendingStderr));
      }
      pendingStderr = "";
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      pendingStderr += text;
      const lines = pendingStderr.split(/\r?\n/);
      pendingStderr = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(SESSION_READY_PREFIX)) {
          handleSessionReadyLine(line, options);
        } else {
          process.stderr.write(`${line}\n`);
          stderrChunks.push(Buffer.from(`${line}\n`));
        }
      }
    });
    child.on("error", (err) => {
      flushPendingStderr();
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: err.message,
      });
    });
    child.on("close", (code, signal) => {
      flushPendingStderr();
      finish({
        exitCode: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: aborted
          ? "Command aborted."
          : timedOut
          ? `Command timed out after ${options.timeoutMs}ms.`
          : signal
            ? `Command exited after signal ${signal}.`
            : undefined,
      });
    });

    child.stdin?.on("error", () => {});
    if (aborted) {
      child.stdin?.end();
    } else {
      child.stdin?.end(input ?? "");
    }
  });
}

function readCapabilities(
  binaryPath: string,
  run: CommandRunner,
  timeoutMs: number | null,
): PluginCapabilities | null {
  const result = run(
    binaryPath,
    ["plugin", "capabilities"],
    undefined,
    { timeoutMs },
  );
  if (result.exitCode !== 0) return null;
  return parsePluginCapabilities(result.stdout);
}

function incompatibleMessage(binaryPath: string): string {
  return `The Plannotator binary at ${binaryPath} does not support the required plugin integration protocol.`;
}

export function ensurePlannotatorBinary(
  options: EnsurePlannotatorBinaryOptions = {},
): EnsurePlannotatorBinaryResult {
  const run = options.run ?? defaultRunner;
  const capabilityTimeoutMs = options.capabilityTimeoutMs === undefined
    ? DEFAULT_CAPABILITY_TIMEOUT_MS
    : options.capabilityTimeoutMs;
  const compatibility = options.requiredFeatures
    ? { requiredFeatures: options.requiredFeatures }
    : {};
  const discovery = discoverPlannotatorBinaryCandidates(options);

  for (const candidate of discovery.candidates) {
    const capabilities = readCapabilities(candidate.path, run, capabilityTimeoutMs);
    if (capabilities && isCompatiblePluginBinary(capabilities, compatibility)) {
      return {
        ok: true,
        path: candidate.path,
        source: candidate.source,
        installed: false,
        capabilities,
      };
    }
  }

  const firstCandidate = discovery.candidates[0];
  if (firstCandidate) {
    if (!shouldAutoInstallPlannotator(options.env)) {
      return {
        ok: false,
        code: "incompatible-binary",
        message: incompatibleMessage(firstCandidate.path),
        checked: discovery.checked,
      };
    }
  } else if (!shouldAutoInstallPlannotator(options.env)) {
    return {
      ok: false,
      code: "missing-binary",
      message: "The Plannotator binary was not found and automatic installation is disabled.",
      checked: discovery.checked,
    };
  }

  const installer = getOfficialInstallerCommand(options.platform, options.installVersion);
  const installResult = run(installer.command, installer.args);
  if (installResult.exitCode !== 0) {
    return {
      ok: false,
      code: "install-failed",
      message: installResult.stderr || installResult.error || "The official Plannotator installer failed.",
      checked: discovery.checked,
    };
  }

  const afterInstall = discoverInstalledPlannotatorBinary(options);
  if (!afterInstall.found || !afterInstall.path || !afterInstall.source) {
    return {
      ok: false,
      code: "install-missing-binary",
      message: "The Plannotator installer completed, but the binary could not be found.",
      checked: afterInstall.checked,
    };
  }

  const capabilities = readCapabilities(afterInstall.path, run, capabilityTimeoutMs);
  if (!capabilities || !isCompatiblePluginBinary(capabilities, compatibility)) {
    return {
      ok: false,
      code: "incompatible-binary",
      message: incompatibleMessage(afterInstall.path),
      checked: afterInstall.checked,
    };
  }

  return {
    ok: true,
    path: afterInstall.path,
    source: afterInstall.source,
    installed: true,
    capabilities,
  };
}

export function runPluginPlan(
  binaryPath: string,
  request: PluginPlanRequest,
  run: PluginCommandRunner = defaultPluginRunner,
  options: CommandRunOptions = {},
): Promise<PluginResponse<PluginPlanResult>> {
  return runPluginCommand(binaryPath, "plan", request, run, options);
}

export function runPluginReview(
  binaryPath: string,
  request: PluginReviewRequest,
  run: PluginCommandRunner = defaultPluginRunner,
  options: CommandRunOptions = {},
): Promise<PluginResponse<PluginReviewResult>> {
  return runPluginCommand(binaryPath, "review", request, run, options);
}

export function runPluginAnnotate(
  binaryPath: string,
  request: PluginAnnotateRequest,
  run: PluginCommandRunner = defaultPluginRunner,
  options: CommandRunOptions = {},
): Promise<PluginResponse<PluginAnnotateResult>> {
  return runPluginCommand(binaryPath, "annotate", request, run, options);
}

export function runPluginArchive(
  binaryPath: string,
  request: PluginArchiveRequest,
  run: PluginCommandRunner = defaultPluginRunner,
  options: CommandRunOptions = {},
): Promise<PluginResponse<PluginArchiveResult>> {
  return runPluginCommand(binaryPath, "archive", request, run, options);
}

async function runPluginCommand<TRequest extends { origin: string }, TResult extends PluginPlanResult | PluginReviewResult | PluginAnnotateResult | PluginArchiveResult>(
  binaryPath: string,
  command: "plan" | "review" | "annotate" | "archive",
  request: TRequest,
  run: PluginCommandRunner,
  options: CommandRunOptions,
): Promise<PluginResponse<TResult>> {
  const result = await run(
    binaryPath,
    ["plugin", command, "--origin", request.origin],
    JSON.stringify(request),
    options,
  );
  const parsed = parsePluginResponse<TResult>(result.stdout);
  if (parsed) return parsed;

  return createPluginErrorResponse(
    result.exitCode === 0 ? "invalid-plugin-response" : "plugin-command-failed",
    result.exitCode === 0
      ? result.stderr || result.error || `The Plannotator plugin ${command} command did not return valid JSON.`
      : result.error || result.stderr || `The Plannotator plugin ${command} command did not return valid JSON.`,
  ) as PluginResponse<TResult>;
}
