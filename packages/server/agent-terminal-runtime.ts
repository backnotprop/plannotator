/**
 * Agent-terminal runtime resolution.
 *
 * Why this exists: Bun cannot dlopen the native `node-pty` addon, so the PTY
 * can't run in-process. Instead it runs in a spawned **Node.js (>=20)** sidecar
 * (`agent-terminal-node-sidecar.mjs`), which imports `@plannotator/webtui`'s
 * server (the package that owns node-pty). This module's job is to locate a
 * usable Node + sidecar + webtui runtime, in one of two modes:
 *
 *   - **bundled (dev):** the sidecar `.mjs` is on real disk next to this source,
 *     so Node resolves webtui/node-pty straight from the repo's node_modules.
 *   - **managed (compiled release binary):** the sidecar is a Bun *virtual*
 *     path (not real disk), so we materialize it to the data dir and rely on a
 *     webtui runtime `npm install`-ed there ahead of time by
 *     `plannotator install-runtime agent-terminal` (run by scripts/install.sh).
 *
 * See ADR adr/implementation/annotate-agent-terminal.md for the full design.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { AgentTerminalDisabledReason } from "@plannotator/shared/agent-terminal";

// @ts-ignore - Bun import attribute for text
import nodeAgentTerminalSidecarSource from "./agent-terminal-node-sidecar.mjs" with { type: "text" };

export const AGENT_TERMINAL_WEBTUI_VERSION = "0.1.0";

const NODE_VERSION_TIMEOUT_MS = 3_000;
const NODE_IMPORT_TIMEOUT_MS = 5_000;
const NPM_INSTALL_TIMEOUT_MS = 120_000;

export type ResolvedAgentTerminalRuntime = {
  ok: true;
  nodePath: string;
  sidecarPath: string;
  sidecarCwd: string;
  webtuiCoreUrl: string;
  webtuiServerUrl: string;
};

export type UnresolvedAgentTerminalRuntime = {
  ok: false;
  reason: AgentTerminalDisabledReason;
  message: string;
};

export type AgentTerminalRuntimeInstallResult =
  | {
      ok: true;
      status: "installed" | "already-installed" | "skipped";
      runtimeDir: string;
      message: string;
    }
  | {
      ok: false;
      status: "failed";
      runtimeDir: string;
      message: string;
    };

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function getAgentTerminalManagedRuntimeDir(
  dataDir = getPlannotatorDataDir(),
): string {
  return join(dataDir, "vendor", "agent-terminal", `webtui-${AGENT_TERMINAL_WEBTUI_VERSION}`);
}

export function isAgentTerminalRemoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.PLANNOTATOR_AGENT_TERMINAL_REMOTE);
}

export function shouldSkipAgentTerminalRuntimeInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL);
}

export async function resolveAgentTerminalRuntime(): Promise<ResolvedAgentTerminalRuntime | UnresolvedAgentTerminalRuntime> {
  const nodePath = Bun.which("node");
  if (!nodePath) {
    return {
      ok: false,
      reason: "pty-unavailable",
      message: "Node.js 20 or newer is required for the annotate agent terminal.",
    };
  }

  const nodeCheck = await checkNodeVersion(nodePath);
  if (!nodeCheck.ok) return nodeCheck;

  // Prefer the bundled (dev) sidecar when it's on real disk; fall back to the
  // managed runtime otherwise. `resolveBundledAgentTerminalSidecarPath` returns
  // null when the path is a Bun *virtual* path — i.e. we're running from the
  // compiled binary — which is exactly how we distinguish dev from a release
  // build. Bundled resolution can also fail its preflight (e.g. webtui not in
  // the repo node_modules), in which case we still try the managed runtime.
  const bundledSidecarPath = resolveBundledAgentTerminalSidecarPath();
  if (bundledSidecarPath) {
    const bundledRuntime = await resolveBundledAgentTerminalRuntime(nodePath, bundledSidecarPath);
    if (bundledRuntime.ok) return bundledRuntime;
  }

  return resolveManagedAgentTerminalRuntime(nodePath);
}

export function resolveBundledAgentTerminalSidecarPath(moduleUrl = import.meta.url): string | null {
  const bundledSidecarPath = fileURLToPath(new URL("./agent-terminal-node-sidecar.mjs", moduleUrl));
  if (isBunVirtualPath(bundledSidecarPath)) return null;
  return existsSync(bundledSidecarPath) ? bundledSidecarPath : null;
}

async function resolveBundledAgentTerminalRuntime(
  nodePath: string,
  bundledSidecarPath: string,
): Promise<ResolvedAgentTerminalRuntime | UnresolvedAgentTerminalRuntime> {
  const webtuiCoreUrl = resolveImportUrl("@plannotator/webtui/core");
  const webtuiServerUrl = resolveImportUrl("@plannotator/webtui/server");
  const preflight = await preflightNodeImports(nodePath, {
    cwd: process.cwd(),
    webtuiCoreUrl,
    webtuiServerUrl,
  });
  if (!preflight.ok) return preflight;
  return {
    ok: true,
    nodePath,
    sidecarPath: bundledSidecarPath,
    sidecarCwd: process.cwd(),
    webtuiCoreUrl,
    webtuiServerUrl,
  };
}

async function resolveManagedAgentTerminalRuntime(
  nodePath: string,
): Promise<ResolvedAgentTerminalRuntime | UnresolvedAgentTerminalRuntime> {
  const runtimeDir = getAgentTerminalManagedRuntimeDir();
  const installedVersion = readInstalledWebTuiVersion(runtimeDir);
  if (installedVersion !== AGENT_TERMINAL_WEBTUI_VERSION) {
    return {
      ok: false,
      reason: "runtime-unavailable",
      message: installedVersion
        ? `Agent terminal runtime has @plannotator/webtui ${installedVersion}; expected ${AGENT_TERMINAL_WEBTUI_VERSION}. Run plannotator install-runtime agent-terminal.`
        : "Agent terminal runtime is not installed. Run plannotator install-runtime agent-terminal or reinstall Plannotator.",
    };
  }

  const sidecarPath = tryMaterializeAgentTerminalSidecar(runtimeDir);
  if (!sidecarPath.ok) return sidecarPath;
  const preflight = await preflightNodeImports(nodePath, {
    cwd: runtimeDir,
    webtuiCoreUrl: "@plannotator/webtui/core",
    webtuiServerUrl: "@plannotator/webtui/server",
  });
  if (!preflight.ok) return preflight;

  return {
    ok: true,
    nodePath,
    sidecarPath: sidecarPath.path,
    sidecarCwd: runtimeDir,
    webtuiCoreUrl: "@plannotator/webtui/core",
    webtuiServerUrl: "@plannotator/webtui/server",
  };
}

export async function installAgentTerminalRuntime(): Promise<AgentTerminalRuntimeInstallResult> {
  const runtimeDir = getAgentTerminalManagedRuntimeDir();

  if (shouldSkipAgentTerminalRuntimeInstall()) {
    return {
      ok: true,
      status: "skipped",
      runtimeDir,
      message: "Skipping agent terminal runtime install (PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set).",
    };
  }

  const nodePath = Bun.which("node");
  if (!nodePath) {
    return fail(runtimeDir, "Skipping agent terminal runtime install (Node.js 20 or newer was not found).");
  }

  const nodeCheck = await checkNodeVersion(nodePath);
  if (!nodeCheck.ok) return fail(runtimeDir, `Skipping agent terminal runtime install (${nodeCheck.message})`);

  const npmPath = Bun.which("npm");
  if (!npmPath) {
    return fail(runtimeDir, "Skipping agent terminal runtime install (npm was not found).");
  }

  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeRuntimePackageJson(runtimeDir);
    materializeAgentTerminalSidecar(runtimeDir);
  } catch (err) {
    return fail(runtimeDir, `Skipping agent terminal runtime install (${formatError(err)}).`);
  }

  if (readInstalledWebTuiVersion(runtimeDir) === AGENT_TERMINAL_WEBTUI_VERSION) {
    const preflight = await preflightNodeImports(nodePath, {
      cwd: runtimeDir,
      webtuiCoreUrl: "@plannotator/webtui/core",
      webtuiServerUrl: "@plannotator/webtui/server",
    });
    if (preflight.ok) {
      return {
        ok: true,
        status: "already-installed",
        runtimeDir,
        message: `Agent terminal runtime already installed at ${runtimeDir}.`,
      };
    }
  }

  const install = await runCommand(
    npmPath,
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      `@plannotator/webtui@${AGENT_TERMINAL_WEBTUI_VERSION}`,
    ],
    { cwd: runtimeDir, timeoutMs: NPM_INSTALL_TIMEOUT_MS },
  );
  if (install.exitCode !== 0) {
    return fail(runtimeDir, `Skipping agent terminal runtime install (${summarizeCommandFailure(install)}).`);
  }

  const preflight = await preflightNodeImports(nodePath, {
    cwd: runtimeDir,
    webtuiCoreUrl: "@plannotator/webtui/core",
    webtuiServerUrl: "@plannotator/webtui/server",
  });
  if (!preflight.ok) return fail(runtimeDir, `Skipping agent terminal runtime install (${preflight.message})`);

  return {
    ok: true,
    status: "installed",
    runtimeDir,
    message: `Agent terminal runtime installed to ${runtimeDir}.`,
  };
}

function materializeAgentTerminalSidecar(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true });
  const sidecarPath = join(runtimeDir, "agent-terminal-node-sidecar.mjs");
  writeFileSync(sidecarPath, nodeAgentTerminalSidecarSource, "utf8");
  return sidecarPath;
}

function tryMaterializeAgentTerminalSidecar(
  runtimeDir: string,
): { ok: true; path: string } | UnresolvedAgentTerminalRuntime {
  try {
    return { ok: true, path: materializeAgentTerminalSidecar(runtimeDir) };
  } catch (err) {
    return {
      ok: false,
      reason: "runtime-unavailable",
      message: `Agent terminal runtime sidecar could not be written (${formatError(err)}). Run plannotator install-runtime agent-terminal or reinstall Plannotator.`,
    };
  }
}

function writeRuntimePackageJson(runtimeDir: string): void {
  const packageJsonPath = join(runtimeDir, "package.json");
  const packageJson = {
    private: true,
    type: "module",
    dependencies: {
      "@plannotator/webtui": AGENT_TERMINAL_WEBTUI_VERSION,
    },
  };
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function readInstalledWebTuiVersion(runtimeDir: string): string | null {
  const packageJsonPath = join(runtimeDir, "node_modules", "@plannotator", "webtui", "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function checkNodeVersion(nodePath: string): Promise<{ ok: true } | UnresolvedAgentTerminalRuntime> {
  const result = await runCommand(nodePath, [
    "-e",
    "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1);",
  ], { timeoutMs: NODE_VERSION_TIMEOUT_MS });
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    reason: "pty-unavailable",
    message: `Node.js 20 or newer is required for the annotate agent terminal (${summarizeCommandFailure(result)}).`,
  };
}

async function preflightNodeImports(
  nodePath: string,
  args: {
    cwd: string;
    webtuiCoreUrl: string;
    webtuiServerUrl: string;
  },
): Promise<{ ok: true } | UnresolvedAgentTerminalRuntime> {
  const script = [
    `await import(${JSON.stringify(args.webtuiCoreUrl)});`,
    `await import(${JSON.stringify(args.webtuiServerUrl)});`,
  ].join(" ");
  const result = await runCommand(nodePath, ["--input-type=module", "-e", script], {
    cwd: args.cwd,
    timeoutMs: NODE_IMPORT_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    reason: "runtime-unavailable",
    message: `Agent terminal runtime could not load WebTUI (${summarizeCommandFailure(result)}).`,
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve(124);
    }, options.timeoutMs);
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    Promise.race([proc.exited, timeout]),
    readStream(proc.stdout),
    readStream(proc.stderr),
  ]);
  if (timer) clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function summarizeCommandFailure(result: CommandResult): string {
  if (result.timedOut) return "timed out";
  const text = (result.stderr || result.stdout).trim();
  if (text) {
    return text.split(/\r?\n/).slice(-3).join(" ").trim();
  }
  return `exit ${result.exitCode}`;
}

function fail(runtimeDir: string, message: string): AgentTerminalRuntimeInstallResult {
  return {
    ok: false,
    status: "failed",
    runtimeDir,
    message,
  };
}

function resolveImportUrl(specifier: string): string {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return specifier;
  }
}

function isBunVirtualPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/$bunfs/") ||
    /^[A-Za-z]:\/(?:\$bunfs|~BUN)\//i.test(normalized) ||
    /^\/[A-Za-z]:\/(?:\$bunfs|~BUN)\//i.test(normalized);
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
