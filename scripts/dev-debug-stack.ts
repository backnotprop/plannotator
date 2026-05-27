#!/usr/bin/env bun

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DaemonStartOutput {
  ok?: boolean;
  browserUrl?: string;
  status?: {
    endpoint?: {
      baseUrl?: string;
    };
  };
}

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const noBrowser = args.has("--no-browser");
const noTui = args.has("--no-tui");
const stopOnExit = args.has("--stop-on-exit");
const reuseDaemon = args.has("--reuse-daemon");

if (!skipBuild) {
  await runInherited("bun", ["run", "build:review"]);
  await runInherited("bun", ["run", "build:hook"]);
}

if (!reuseDaemon) {
  await stopDaemonIfRunning();
}

const daemon = await startDaemon();
const baseUrl = daemon.status?.endpoint?.baseUrl;
if (!baseUrl) {
  throw new Error(`Daemon started but did not report a frontend URL: ${JSON.stringify(daemon)}`);
}
const browserUrl = daemon.browserUrl ?? baseUrl;

console.error(`[plannotator] daemon frontend: ${baseUrl}`);

if (!noBrowser) {
  await openBrowser(browserUrl);
}

try {
  if (!noTui) {
    await runInherited("bun", ["run", "--cwd", "apps/debug-tui", "start"], {
      PLANNOTATOR_SIMULATOR_DAEMON_URL: baseUrl,
      ...(daemon.browserUrl ? { PLANNOTATOR_SIMULATOR_DAEMON_BROWSER_URL: daemon.browserUrl } : {}),
    });
  } else {
    console.error(
      stopOnExit
        ? "[plannotator] --no-tui set; stopping daemon before exit."
        : "[plannotator] --no-tui set; leaving daemon running.",
    );
  }
} finally {
  if (stopOnExit) {
    await runCapture("bin/plannotator.js", ["daemon", "stop"]);
  }
}

async function startDaemon(): Promise<DaemonStartOutput> {
  const result = await runCapture("bin/plannotator.js", ["daemon", "start"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start daemon.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const parsed = parseJson<DaemonStartOutput>(result.stdout);
  if (parsed?.ok && parsed.status?.endpoint?.baseUrl) return parsed;

  const status = await runCapture("bin/plannotator.js", ["daemon", "status"]);
  if (status.exitCode !== 0) {
    throw new Error(`Daemon status failed.\nstdout:\n${status.stdout}\nstderr:\n${status.stderr}`);
  }

  const statusJson = parseJson<{ ok?: boolean; status?: DaemonStartOutput["status"]; browserUrl?: string }>(
    status.stdout,
  );
  if (!statusJson?.ok || !statusJson.status?.endpoint?.baseUrl) {
    throw new Error(`Daemon status did not include a frontend URL: ${status.stdout}`);
  }

  return { ok: true, status: statusJson.status, browserUrl: statusJson.browserUrl };
}

async function stopDaemonIfRunning(): Promise<void> {
  const result = await runCapture("bin/plannotator.js", ["daemon", "stop"]);
  const parsed = parseJson<Record<string, unknown>>(result.stdout);
  if (result.exitCode !== 0 && parsed?.code !== "missing") {
    throw new Error(`Failed to stop existing daemon.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function openBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  const result = await runCapture(opener.command, opener.args);
  if (result.exitCode !== 0) {
    console.error(`[plannotator] could not open browser automatically: ${result.stderr.trim()}`);
    console.error(`[plannotator] open manually: ${url}`);
  }
}

async function runInherited(
  command: string,
  commandArgs: string[],
  env?: Record<string, string>,
): Promise<void> {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${exitCode}`);
  }
}

async function runCapture(command: string, commandArgs: string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function parseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}
