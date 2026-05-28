/**
 * Plannotator CLI for Claude Code, Codex, Gemini CLI, and Copilot CLI
 *
 * Supports seven modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by Claude/Gemini/Codex hook entrypoints
 *    - Reads hook event from stdin, extracts plan content
 *    - Serves UI, returns approve/deny decision to stdout
 *
 * 2. Code Review (`plannotator review`, `plannotator review --git`):
 *    - Triggered by /review slash command
 *    - Runs git diff, opens review UI
 *    - Outputs feedback to stdout (captured by slash command)
 *
 * 3. Annotate (`plannotator annotate <file.md>`):
 *    - Triggered by /plannotator-annotate slash command
 *    - Opens any markdown file in the annotation UI
 *    - Outputs structured feedback to stdout
 *
 * 4. Sessions (`plannotator sessions`):
 *    - Lists active Plannotator server sessions
 *    - `--open [N]` reopens a session in the browser
 *    - `--clean` removes stale session files
 *
 * 6. Copilot Plan (`plannotator copilot-plan`):
 *    - Spawned by preToolUse hook (Copilot CLI)
 *    - Intercepts exit_plan_mode, reads plan.md from session state
 *    - Outputs permissionDecision JSON to stdout
 *
 * 7. Copilot Last (`plannotator copilot-last`):
 *    - Annotate the last assistant message from a Copilot CLI session
 *    - Parses events.jsonl from session state
 *
 * 8. Improve Context (`plannotator improve-context`):
 *    - Spawned by PreToolUse hook on EnterPlanMode
 *    - Reads improvement hook file from ~/.plannotator/hooks/
 *    - Returns additionalContext or silently passes through
 *
 * Global flags:
 *   --help             - Show top-level usage information
 *   --version, -v      - Print version and exit
 *   --browser <name>   - Override which browser to open (e.g. "Google Chrome")
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import {
  normalizeGoalSetupBundle,
  type GoalSetupStage,
} from "@plannotator/shared/goal-setup";
import { statSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";

import { openBrowser } from "@plannotator/server/browser";
import { cleanupDaemonState, discoverDaemon, waitForDaemonShutdown } from "@plannotator/server/daemon/client";
import { startDaemonRuntime } from "@plannotator/server/daemon/runtime";
import { createDaemonSessionFactory } from "@plannotator/server/daemon/session-factory";
import { getDaemonStartCommand } from "@plannotator/server/daemon/start-command";
import { createDaemonBrowserAuthUrl } from "@plannotator/server/daemon/state";
import { formatRemoteShareNotice } from "@plannotator/server/share-url";
import { AGENT_CONFIG, type Origin } from "@plannotator/shared/agents";
import type { DaemonSessionSummary } from "@plannotator/shared/daemon-protocol";
import {
  createPluginErrorResponse,
  createPluginSuccessResponse,
  getPluginCapabilities,
  type PluginActionResult,
  type PluginAnnotateRequest,
  type PluginBaseRequest,
  type PluginClientOrigin,
  type PluginPlanRequest,
  type PluginRequest,
  type PluginReviewRequest,
  type PluginSessionInfo,
} from "@plannotator/shared/plugin-protocol";
import {
  findSessionLogsByAncestorWalk,
  findSessionLogsForCwd,
  getLastRenderedMessage,
  resolveSessionLogByAncestorPids,
  resolveSessionLogByCwdScan,
  type RenderedMessage,
} from "./session-log";
import { findCodexRolloutByThreadId, getLastCodexMessage, getLatestCodexPlan } from "./codex-session";
import { findCopilotPlanContent, findCopilotSessionForCwd, getLastCopilotMessage } from "./copilot-session";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  formatVersion,
  isInteractiveNoArgInvocation,
  isTopLevelHelpInvocation,
  isVersionInvocation,
} from "./cli";
import path from "path";

let daemonShellHtmlContentPromise: Promise<string> | undefined;

const DEV_FALLBACK_HTML = "<html><head><title>Plannotator</title></head><body><p>Frontend not built. Run <code>bun run --cwd apps/frontend build</code> first.</p></body></html>";

function getDaemonShellHtmlContent(): Promise<string> {
  daemonShellHtmlContentPromise ??= import("./daemon-shell-html")
    .then((mod) => mod.loadDaemonShellHtml())
    .catch(() => DEV_FALLBACK_HTML);
  return daemonShellHtmlContentPromise;
}

async function loadGoalSetupBundle(stage: GoalSetupStage, bundlePath: string) {
  const raw =
    bundlePath === "-"
      ? await Bun.stdin.text()
      : await Bun.file(path.resolve(getInvocationCwd(), bundlePath)).text();
  return normalizeGoalSetupBundle(JSON.parse(raw), stage);
}

// Check for subcommand
const args = process.argv.slice(2);
const launcherCwd = process.cwd();

// Global flag: --browser <name>
const browserIdx = args.indexOf("--browser");
if (browserIdx !== -1 && args[browserIdx + 1]) {
  process.env.PLANNOTATOR_BROWSER = args[browserIdx + 1];
  args.splice(browserIdx, 2);
}

// Global flag: --no-jina (disables Jina Reader for URL annotation)
const noJinaIdx = args.indexOf("--no-jina");
const cliNoJina = noJinaIdx !== -1;
if (cliNoJina) args.splice(noJinaIdx, 1);

// Annotate review-gate flags (#570): --gate adds an Approve button,
// --json switches stdout to structured decision output, --hook emits
// hook-native JSON that works directly with Claude Code and Codex
// PostToolUse/Stop hook protocols.
const gateIdx = args.indexOf("--gate");
let gateFlag = gateIdx !== -1;
if (gateFlag) args.splice(gateIdx, 1);
const jsonIdx = args.indexOf("--json");
const jsonFlag = jsonIdx !== -1;
if (jsonFlag) args.splice(jsonIdx, 1);
const hookIdx = args.indexOf("--hook");
const hookFlag = hookIdx !== -1;
if (hookFlag) args.splice(hookIdx, 1);
if (hookFlag) gateFlag = true;
const renderHtmlIdx = args.indexOf("--render-html");
const renderHtmlFlag = renderHtmlIdx !== -1;
if (renderHtmlFlag) args.splice(renderHtmlIdx, 1);

// Stdout matrix for annotate / annotate-last / copilot annotate-last (#570).
//
// --hook (recommended for hooks):
//   Approve/Close → empty stdout (hook passes, agent proceeds).
//   Annotate → {"decision":"block","reason":"<feedback>"} (hook blocks).
//   Works with both Claude Code and Codex hook protocols.
//
// --json (structured decisions for wrapper scripts):
//   Emits {"decision":"approved|dismissed|annotated","feedback":"..."}.
//
// Plaintext (default):
//   Close → empty. Approve → "The user approved." Annotate → feedback.
//
// TODO: The plaintext --gate approval sentinel must stay as the exact string
// "The user approved." because slash command templates (plannotator-annotate.md,
// plannotator-last.md) instruct the agent to match it literally. Making this
// configurable requires updating those templates to accept dynamic values or
// switching gate mode to structured output only.
const APPROVED_PLAINTEXT_MARKER = "The user approved.";

function emitAnnotateOutcome(result: {
  feedback: string;
  prompt?: string;
  exit?: boolean;
  approved?: boolean;
}): void {
  if (hookFlag) {
    if (result.approved || result.exit) return;
    if (result.feedback) {
      console.log(JSON.stringify({ decision: "block", reason: result.feedback }));
    }
    return;
  }
  if (jsonFlag) {
    if (result.approved) {
      console.log(JSON.stringify({ decision: "approved" }));
    } else if (result.exit) {
      console.log(JSON.stringify({ decision: "dismissed" }));
    } else {
      console.log(JSON.stringify({ decision: "annotated", feedback: result.feedback || "" }));
    }
    return;
  }
  const output = result.prompt ?? result.feedback;
  if (result.exit) return;
  if (result.approved) {
    console.log(APPROVED_PLAINTEXT_MARKER);
    return;
  }
  if (output) console.log(output);
}

if (isVersionInvocation(args)) {
  console.log(formatVersion());
  process.exit(0);
}

if (isTopLevelHelpInvocation(args)) {
  console.log(formatTopLevelHelp());
  process.exit(0);
}

if (isInteractiveNoArgInvocation(args, process.stdin.isTTY)) {
  console.log(formatInteractiveNoArgClarification());
  process.exit(0);
}

// Check if URL sharing is enabled (default: true)
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

// Custom share portal URL for self-hosting
const shareBaseUrl = process.env.PLANNOTATOR_SHARE_URL || undefined;

// Paste service URL for short URL sharing
const pasteApiUrl = process.env.PLANNOTATOR_PASTE_URL || undefined;

// Detect calling agent from environment variables set by agent runtimes.
// Priority:
//   PLANNOTATOR_ORIGIN (explicit override, validated against AGENT_CONFIG)
//   > Codex (CODEX_THREAD_ID)
//   > Copilot CLI (COPILOT_CLI)
//   > OpenCode (OPENCODE)
//   > Gemini CLI (GEMINI_CLI)
//   > Claude Code (default fallback)
//
// To add a new agent, also add an entry to AGENT_CONFIG in
// packages/shared/agents.ts (see header comment there).
const originOverride = process.env.PLANNOTATOR_ORIGIN as Origin | undefined;
const detectedOrigin: Origin =
  (originOverride && originOverride in AGENT_CONFIG) ? originOverride :
  process.env.CODEX_THREAD_ID ? "codex" :
  process.env.COPILOT_CLI ? "copilot-cli" :
  process.env.OPENCODE ? "opencode" :
  process.env.GEMINI_CLI ? "gemini-cli" :
  "claude-code";

async function runDaemonCommand(): Promise<void> {
  const command = args[1] ?? "status";
  const foreground = args.includes("--foreground");

  if (command === "status") {
    const daemon = await discoverDaemon({ validateEnvironment: false });
    if (!daemon.ok) {
      console.log(JSON.stringify({ ok: false, code: daemon.code, message: daemon.message }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      status: daemon.status,
      browserUrl: createDaemonBrowserAuthUrl(daemon.state),
    }));
    process.exit(0);
  }

  if (command === "stop") {
    const daemon = await discoverDaemon({ validateEnvironment: false });
    if (!daemon.ok) {
      if (daemon.state && (daemon.code === "incompatible" || daemon.code === "unhealthy")) {
        await cleanupDaemonStateForDaemonCommand(daemon.state);
        console.log(JSON.stringify({ ok: true, stopped: true, recovered: daemon.code }));
        process.exit(0);
      }
      if (daemon.code === "missing" || daemon.code === "stale" || daemon.code === "malformed") {
        console.log(JSON.stringify({ ok: true, stopped: false, code: daemon.code, message: daemon.message }));
        process.exit(0);
      }
      console.log(JSON.stringify({ ok: false, code: daemon.code, message: daemon.message }));
      process.exit(1);
    }
    const result = await daemon.client.shutdown();
    if ("ok" in result && result.ok) {
      const stopped = await waitForDaemonShutdown(daemon.state);
      if (!stopped) {
        console.log(JSON.stringify({ ok: false, code: "daemon-stop-timeout", message: "Timed out waiting for the Plannotator daemon to stop." }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(result));
    process.exit("ok" in result && result.ok ? 0 : 1);
  }

  if (command === "start") {
    const existing = await discoverDaemon();
    if (existing.ok) {
      console.log(JSON.stringify({
        ok: true,
        alreadyRunning: true,
        status: existing.status,
        browserUrl: createDaemonBrowserAuthUrl(existing.state),
      }));
      process.exit(0);
    }
    if (existing.state && (existing.code === "incompatible" || existing.code === "unhealthy")) {
      await cleanupDaemonStateForDaemonCommand(existing.state);
    } else if (existing.code === "mismatch") {
      console.log(JSON.stringify({ ok: false, code: existing.code, message: existing.message }));
      process.exit(1);
    }

    if (!foreground) {
      const startLogPath = path.join(tmpdir(), `plannotator-daemon-start-${process.pid}-${Date.now()}.log`);
      const child = Bun.spawn(getDaemonStartCommand(process.argv, process.execPath, launcherCwd), {
        cwd: getInvocationCwd(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: Bun.file(startLogPath),
        detached: true,
      });
      child.unref();
      let startExit: { exitCode?: number; error?: unknown } | undefined;
      void child.exited
        .then((exitCode) => {
          startExit = { exitCode };
        })
        .catch((error) => {
          startExit = { error };
        });

      for (let attempt = 0; attempt < 30; attempt++) {
        await Bun.sleep(100);
        const daemon = await discoverDaemon();
        if (daemon.ok) {
          try { rmSync(startLogPath, { force: true }); } catch {}
          console.log(JSON.stringify({
            ok: true,
            started: true,
            status: daemon.status,
            browserUrl: createDaemonBrowserAuthUrl(daemon.state),
          }));
          process.exit(0);
        }
        if (startExit) {
          const log = await readDaemonStartLog(startLogPath);
          const detail = startExit.error instanceof Error
            ? startExit.error.message
            : `exited with code ${startExit.exitCode ?? "unknown"}`;
          console.log(JSON.stringify({
            ok: false,
            code: "daemon-start-failed",
            message: `Plannotator daemon start ${detail}.${log ? `\n${log}` : ""}`,
          }));
          process.exit(1);
        }
      }

      if (!startExit) {
        await stopDaemonStartChild(child);
      }
      const log = await readDaemonStartLog(startLogPath);
      console.log(JSON.stringify({
        ok: false,
        code: "daemon-start-failed",
        message: `Timed out waiting for the Plannotator daemon to start.${log ? `\n${log}` : ""}`,
      }));
      process.exit(1);
    }

    let runtime: Awaited<ReturnType<typeof startDaemonRuntime>>;
    try {
      runtime = await startDaemonRuntime({
        shellHtmlContent: await getDaemonShellHtmlContent(),
        createSession: createDaemonSessionFactory({
          sharingEnabled,
          shareBaseUrl,
          pasteApiUrl,
        }),
        onShutdown: () => {
          setTimeout(() => process.exit(0), 10);
        },
      });
    } catch (err) {
      const payload = {
        ok: false,
        code: "daemon-start-failed",
        message: err instanceof Error ? err.message : "Failed to start Plannotator daemon.",
      };
      console.error(JSON.stringify(payload));
      console.log(JSON.stringify(payload));
      process.exit(1);
    }

    console.log(JSON.stringify({ ok: true, started: true, browserUrl: createDaemonBrowserAuthUrl(runtime.state), status: {
      pid: runtime.state.pid,
      endpoint: {
        hostname: runtime.state.hostname,
        port: runtime.state.port,
        baseUrl: runtime.state.baseUrl,
        isRemote: runtime.state.isRemote,
      },
      protocol: runtime.state.protocol,
      protocolVersion: runtime.state.protocolVersion,
      startedAt: runtime.state.startedAt,
      activeSessionCount: 0,
      sessionCount: 0,
    } }));

    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      runtime.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => {});
  }

  console.error("Usage: plannotator daemon start|status|stop");
  process.exit(1);
}

function emitPluginError(code: string, message: string, exitCode = 1): never {
  console.log(JSON.stringify(createPluginErrorResponse(code, message)));
  process.exit(exitCode);
}

function emitCommandError(_code: string, message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function cleanupDaemonStateForDaemonCommand(state: unknown): Promise<void> {
  try {
    await cleanupDaemonState(state);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, code: "daemon-cleanup-failed", message: errorMessage(err) }));
    process.exit(1);
  }
}

async function cleanupDaemonStateForSessionCommand(state: unknown, options: { pluginError?: boolean; bestEffort?: boolean }): Promise<void> {
  try {
    await cleanupDaemonState(state);
  } catch (err) {
    if (options.bestEffort) throw err;
    const fail = options.pluginError ? emitPluginError : emitCommandError;
    fail("daemon-cleanup-failed", errorMessage(err));
  }
}

async function readPluginRequest<T extends PluginBaseRequest>(): Promise<Partial<T>> {
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    emitPluginError(
      "invalid-json",
      err instanceof Error ? err.message : "Invalid JSON request",
    );
  }
}

function getPluginOrigin(request: Partial<PluginBaseRequest>): PluginClientOrigin {
  const originIndex = args.indexOf("--origin");
  const originArg = originIndex >= 0 ? args[originIndex + 1] : undefined;
  const origin = request.origin || originArg || detectedOrigin;
  if (origin !== "opencode" && origin !== "pi") {
    emitPluginError(
      "invalid-origin",
      `Plugin origin must be "opencode" or "pi"; got ${String(origin || "")}`,
    );
  }
  return origin;
}

function getInvocationCwd(): string {
  return process.env.PLANNOTATOR_CWD || process.cwd();
}

async function readDaemonStartLog(logPath: string): Promise<string> {
  try {
    return (await Bun.file(logPath).text()).trim();
  } catch {
    return "";
  } finally {
    try { rmSync(logPath, { force: true }); } catch {}
  }
}

async function stopDaemonStartChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try { child.kill("SIGTERM"); } catch {}
  const exited = await Promise.race([
    child.exited.then(() => true).catch(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function resolvePluginCwd(request: Partial<PluginBaseRequest>): string {
  const cwd = path.resolve(request.cwd || getInvocationCwd());
  try {
    if (!statSync(cwd).isDirectory()) {
      emitPluginError("invalid-cwd", `Invalid cwd: ${request.cwd || cwd}`);
    }
  } catch (err) {
    emitPluginError(
      "invalid-cwd",
      err instanceof Error ? err.message : `Invalid cwd: ${request.cwd || cwd}`,
    );
  }
  try {
    process.chdir(cwd);
  } catch (err) {
    emitPluginError(
      "invalid-cwd",
      err instanceof Error ? err.message : `Invalid cwd: ${request.cwd || cwd}`,
    );
  }
  return cwd;
}

async function ensureDaemonClient(options: { pluginError?: boolean; bestEffort?: boolean } = {}) {
  const fail = options.bestEffort
    ? (code: string, message: string) => { throw new Error(`${code}: ${message}`); }
    : options.pluginError ? emitPluginError : emitCommandError;
  const existing = await discoverDaemon();
  if (existing.ok) return existing.client;
  if (existing.state && (existing.code === "incompatible" || existing.code === "unhealthy")) {
    await cleanupDaemonStateForSessionCommand(existing.state, options);
  } else if (existing.code === "mismatch") {
    fail(`daemon-${existing.code}`, existing.message);
  }

  const command = getDaemonStartCommand(process.argv, process.execPath, launcherCwd);
  const startLogPath = path.join(tmpdir(), `plannotator-daemon-start-${process.pid}-${Date.now()}.log`);
  const child = Bun.spawn(command, {
    cwd: getInvocationCwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(startLogPath),
    detached: true,
  });
  child.unref();
  let startExit: { exitCode?: number; error?: unknown } | undefined;
  void child.exited
    .then((exitCode) => {
      startExit = { exitCode };
    })
    .catch((error) => {
      startExit = { error };
    });

  let lastStartProblem: Awaited<ReturnType<typeof discoverDaemon>> | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(100);
    const daemon = await discoverDaemon();
    if (daemon.ok) {
      try { rmSync(startLogPath, { force: true }); } catch {}
      return daemon.client;
    }
    if (daemon.code === "mismatch") {
      await stopDaemonStartChild(child);
      fail(`daemon-${daemon.code}`, daemon.message);
    }
    if (daemon.code !== "missing" && daemon.code !== "stale") {
      lastStartProblem = daemon;
    }
    if (startExit && attempt >= 10) {
      const log = await readDaemonStartLog(startLogPath);
      const detail = startExit.error instanceof Error
        ? startExit.error.message
        : `exited with code ${startExit.exitCode ?? "unknown"}`;
      fail(
        "daemon-start-failed",
        `Plannotator daemon start ${detail}.${log ? `\n${log}` : ""}`,
      );
    }
  }

  if (!startExit) {
    await stopDaemonStartChild(child);
  }
  try { rmSync(startLogPath, { force: true }); } catch {}
  if (lastStartProblem && !lastStartProblem.ok) {
    fail(`daemon-${lastStartProblem.code}`, lastStartProblem.message);
  }
  fail("daemon-start-failed", "Timed out waiting for the Plannotator daemon to start.");
}

function registerDaemonSessionInterruptCleanup(
  cancelSession: () => Promise<void>,
  options: { cancelOnSigterm?: boolean } = {},
): () => void {
  let cancelling = false;
  const cancelOnSigterm = options.cancelOnSigterm ?? true;
  const handleSignal = (exitCode: number) => {
    if (cancelling) return;
    cancelling = true;
    void cancelSession().finally(() => process.exit(exitCode));
  };
  const onSigint = () => handleSignal(130);
  const onSigterm = () => handleSignal(143);
  process.once("SIGINT", onSigint);
  if (cancelOnSigterm) process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    if (cancelOnSigterm) process.off("SIGTERM", onSigterm);
  };
}

async function runDaemonSessionRequest(request: PluginRequest, options: { pluginError?: boolean } = {}): Promise<{
  result: PluginActionResult;
  session: PluginSessionInfo;
}> {
  const fail = options.pluginError ? emitPluginError : emitCommandError;
  let daemon: Awaited<ReturnType<typeof ensureDaemonClient>> | undefined;
  let createdSessionId: string | undefined;
  let unregisterInterruptCleanup: (() => void) | undefined;

  const cancelCreatedSession = async () => {
    if (!daemon || !createdSessionId) return;
    await daemon.cancelSession(createdSessionId).catch(() => undefined);
  };

  try {
    daemon = await ensureDaemonClient(options);
    const created = await daemon.createSession({ request });
    if (created.ok !== true) {
      fail(created.error.code, created.error.message);
    }
    createdSessionId = created.session.id;
    unregisterInterruptCleanup = registerDaemonSessionInterruptCleanup(cancelCreatedSession, {
      cancelOnSigterm: !options.pluginError,
    });

    const sessionUrl = new URL(created.session.url);
    const session: PluginSessionInfo = {
      mode: created.session.mode,
      url: created.session.url,
      port: Number(sessionUrl.port),
      isRemote: daemon.state.isRemote,
    };
    if (created.session.remoteShare) {
      process.stderr.write(formatRemoteShareNotice(created.session.remoteShare));
    } else if (daemon.state.isRemote) {
      process.stderr.write(`\n  Open this forwarded Plannotator session URL:\n  ${created.session.url}\n\n`);
    }
    if (options.pluginError) {
      emitPluginSessionReady(session);
    }

    const completed = await daemon.waitForResult<PluginActionResult>(created.session.id);
    if (completed.ok !== true) {
      await cancelCreatedSession();
      fail(completed.error.code, completed.error.message);
    }
    if (completed.session.status !== "completed" && completed.session.status !== "awaiting-resubmission" && completed.session.status !== "idle") {
      fail(
        completed.session.status,
        completed.session.error ?? `Plannotator session ${completed.session.id} ended with status ${completed.session.status}.`,
      );
    }

    unregisterInterruptCleanup();
    return {
      result: completed.result,
      session,
    };
  } catch (err) {
    unregisterInterruptCleanup?.();
    await cancelCreatedSession();
    fail("daemon-session-failed", errorMessage(err));
  }
}

async function runDaemonBackedPluginRequest(request: PluginRequest): Promise<void> {
  const outcome = await runDaemonSessionRequest(request, { pluginError: true });
  console.log(JSON.stringify(createPluginSuccessResponse(outcome.result, outcome.session)));
}

function emitPluginSessionReady(session: PluginSessionInfo): void {
  console.error(`PLANNOTATOR_SESSION_READY ${JSON.stringify(session)}`);
}

async function runPluginPlanCommand(): Promise<void> {
  const request = await readPluginRequest<PluginPlanRequest>();
  const origin = getPluginOrigin(request);
  await runDaemonBackedPluginRequest({
    ...request,
    action: "plan",
    origin,
    cwd: resolvePluginCwd(request),
  });
}

async function runPluginAnnotateCommand(defaultMode: "annotate" | "annotate-last" = "annotate"): Promise<void> {
  const request = await readPluginRequest<PluginAnnotateRequest>();
  const origin = getPluginOrigin(request);
  await runDaemonBackedPluginRequest({
    ...request,
    action: defaultMode,
    origin,
    cwd: resolvePluginCwd(request),
    noJina: request.noJina,
    jinaApiKey: process.env.JINA_API_KEY,
  });
}

async function runPluginReviewCommand(): Promise<void> {
  const request = await readPluginRequest<PluginReviewRequest>();
  const origin = getPluginOrigin(request);
  await runDaemonBackedPluginRequest({
    ...request,
    action: "review",
    origin,
    cwd: resolvePluginCwd(request),
  });
}

if (args[0] === "daemon") {
  await runDaemonCommand();
}

if (args[0] === "plugin") {
  const command = args[1];
  if (command === "capabilities") {
    console.log(JSON.stringify(getPluginCapabilities()));
    process.exit(0);
  }

  if (command === "plan") {
    await runPluginPlanCommand();
    process.exit(0);
  }

  if (command === "review") {
    await runPluginReviewCommand();
    process.exit(0);
  }

  if (command === "annotate" || command === "annotate-last") {
    await runPluginAnnotateCommand(command === "annotate-last" ? "annotate-last" : "annotate");
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      createPluginErrorResponse(
        "unknown-plugin-command",
        command ? `Unknown plugin command: ${command}` : "Missing plugin command",
      ),
    ),
  );
  process.exit(1);
}

if (args[0] === "sessions") {
  // ============================================
  // SESSION DISCOVERY MODE
  // ============================================

  const daemon = await discoverDaemon({ validateEnvironment: false });
  if (!daemon.ok) {
    console.error("No active Plannotator daemon.");
    process.exit(0);
  }

  const clean = args.includes("--clean");
  const listResponse = await daemon.client.listSessions({ clean }) as { ok?: boolean; sessions?: DaemonSessionSummary[] };
  const sessions = Array.isArray(listResponse.sessions) ? listResponse.sessions : [];

  if (clean) {
    console.error(`Cleaned up stale sessions. ${sessions.length} active session(s) remain.`);
    process.exit(0);
  }

  if (sessions.length === 0) {
    console.error("No active Plannotator sessions.");
    process.exit(0);
  }

  const openIdx = args.indexOf("--open");
  if (openIdx !== -1) {
    // Open a session in the browser
    const nArg = args[openIdx + 1];
    const n = nArg ? parseInt(nArg, 10) : 1;
    const session = sessions[n - 1];
    if (!session) {
      console.error(`Session #${n} not found. ${sessions.length} active session(s).`);
      process.exit(1);
    }
    await openBrowser(createDaemonBrowserAuthUrl(daemon.state, new URL(session.url).pathname), { isRemote: daemon.status.endpoint.isRemote });
    console.error(`Opened ${session.mode} session in browser: ${session.url}`);
    process.exit(0);
  }

  // List sessions as a table
  console.error("Active Plannotator sessions:\n");
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const age = Math.round((Date.now() - new Date(s.createdAt).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h ${age % 60}m`;
    console.error(`  #${i + 1}  ${s.mode.padEnd(9)} ${s.project.padEnd(20)} ${s.status.padEnd(10)} ${s.url.padEnd(28)} ${ageStr} ago`);
  }
  console.error(`\nReopen with: plannotator sessions --open [N]`);
  process.exit(0);

} else if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  const outcome = await runDaemonSessionRequest({
    action: "review",
    origin: detectedOrigin,
    cwd: getInvocationCwd(),
    args: args.slice(1).join(" "),
    sharingEnabled,
    shareBaseUrl,
  });
  const result = outcome.result as { approved?: boolean; feedback?: string; prompt?: string; exit?: boolean };

  if (result.exit) {
    console.log("Review session closed without feedback.");
  } else {
    console.log(result.prompt ?? result.feedback ?? "");
  }
  process.exit(0);

} else if (args[0] === "annotate") {
  // ============================================
  // ANNOTATE MODE
  // ============================================

  const rawFilePath = args[1];
  if (!rawFilePath) {
    console.error("Usage: plannotator annotate <file.md | file.html | https://... | folder/>  [--no-jina] [--gate] [--json] [--hook]");
    process.exit(1);
  }

  const outcome = await runDaemonSessionRequest({
    action: "annotate",
    origin: detectedOrigin,
    cwd: getInvocationCwd(),
    args: rawFilePath,
    noJina: cliNoJina,
    jinaApiKey: process.env.JINA_API_KEY,
    gate: gateFlag,
    renderHtml: renderHtmlFlag,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
  });
  emitAnnotateOutcome(outcome.result as { feedback: string; prompt?: string; exit?: boolean; approved?: boolean });
  process.exit(0);

} else if (args[0] === "annotate-last" || args[0] === "last") {
  // ============================================
  // ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = getInvocationCwd();
  const codexThreadId = process.env.CODEX_THREAD_ID;
  const isCodex = !!codexThreadId;

  let lastMessage: RenderedMessage | null = null;

  if (codexThreadId) {
    // Codex path: find rollout by thread ID
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Codex detected, thread ID: ${codexThreadId}`);
    }
    const rolloutPath = findCodexRolloutByThreadId(codexThreadId);
    if (rolloutPath) {
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Rollout: ${rolloutPath}`);
      }
      const msg = getLastCodexMessage(rolloutPath);
      if (msg) {
        lastMessage = { messageId: codexThreadId, text: msg.text, lineNumbers: [] };
      }
    }
  } else {
    // Claude Code path: resolve session log
    //
    // Strategy (most precise → least precise):
    // 1. Ancestor-PID session metadata: walk up the process tree checking
    //    ~/.claude/sessions/<pid>.json at each hop. When invoked from a slash
    //    command's `!` bang, the direct parent is a bash subshell — Claude's
    //    session file is a few hops up. Deterministic when it matches.
    // 2. Cwd-scan of session metadata: read every ~/.claude/sessions/*.json,
    //    filter by cwd, pick the most recent startedAt. Better than mtime
    //    guessing because it uses session-level metadata.
    // 3. CWD slug match (mtime-based): legacy behavior — picks the most
    //    recently modified jsonl in the project dir. Fragile when multiple
    //    sessions exist for the same project.
    // 4. Ancestor directory walk: handles the case where the user `cd`'d
    //    deeper into a subdirectory after session start.

    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Project root: ${projectRoot}`);
      console.error(`[DEBUG] PPID: ${process.ppid}`);
    }

    /** Try each log path, return the first that yields a message. */
    function tryLogCandidates(label: string, getPaths: () => string[]): void {
      if (lastMessage) return;
      const paths = getPaths();
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] ${label}: ${paths.length ? paths.join(", ") : "(none)"}`);
      }
      for (const logPath of paths) {
        lastMessage = getLastRenderedMessage(logPath);
        if (lastMessage) return;
      }
    }

    // 1. Walk ancestor PIDs for a matching session metadata file
    const ancestorLog = resolveSessionLogByAncestorPids();
    tryLogCandidates("Ancestor PID session metadata", () => ancestorLog ? [ancestorLog] : []);

    // 2. Scan all session metadata files for one whose cwd matches
    const cwdScanLog = resolveSessionLogByCwdScan({ cwd: projectRoot });
    tryLogCandidates("Cwd-scan session metadata", () => cwdScanLog ? [cwdScanLog] : []);

    // 3. Fall back to CWD slug match (mtime-based)
    tryLogCandidates("CWD slug match (mtime)", () => findSessionLogsForCwd(projectRoot));

    // 4. Fall back to ancestor directory walk
    tryLogCandidates("Directory ancestor walk", () => findSessionLogsByAncestorWalk(projectRoot));
  }

  if (!lastMessage) {
    console.error("No rendered assistant message found in session logs.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message ${lastMessage.messageId} (${lastMessage.text.length} chars)`);
  }

  const outcome = await runDaemonSessionRequest({
    action: "annotate-last",
    origin: detectedOrigin,
    cwd: projectRoot,
    markdown: lastMessage.text,
    filePath: "last-message",
    mode: "annotate-last",
    gate: gateFlag,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
  });

  emitAnnotateOutcome(outcome.result as { feedback: string; prompt?: string; exit?: boolean; approved?: boolean });
  process.exit(0);

} else if (args[0] === "setup-goal") {
  // ============================================
  // GOAL SETUP MODE
  // ============================================

  const stage = args[1] as GoalSetupStage | undefined;
  const bundlePath = args[2];

  if ((stage !== "interview" && stage !== "facts") || !bundlePath) {
    console.error(
      "Usage: plannotator setup-goal <interview|facts> <bundle.json | -> [--json]",
    );
    process.exit(1);
  }

  let bundle: Awaited<ReturnType<typeof loadGoalSetupBundle>>;
  try {
    bundle = await loadGoalSetupBundle(stage, bundlePath);
  } catch (err) {
    console.error(
      `Failed to load goal setup bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const outcome = await runDaemonSessionRequest({
    action: "goal-setup",
    origin: detectedOrigin,
    cwd: getInvocationCwd(),
    bundle,
    stage,
    goalSlug: bundle.goalSlug,
  });

  if (outcome?.result) {
    const result = outcome.result as import("@plannotator/shared/plugin-protocol").PluginGoalSetupResult;
    if (result.exit) {
      console.log(JSON.stringify({ decision: "dismissed", stage }));
    } else if (result.result) {
      const output = {
        decision: "submitted",
        stage,
        result: result.result,
      };
      console.log(jsonFlag ? JSON.stringify(output) : JSON.stringify(output, null, 2));
    }
  }
  process.exit(0);

} else if (args[0] === "copilot-plan") {
  // ============================================
  // COPILOT CLI PLAN INTERCEPTION MODE
  // ============================================
  //
  // Called by preToolUse hook on EVERY tool call in Copilot CLI.
  // Must filter quickly and only activate for exit_plan_mode.
  // No output = allow the tool call to proceed.

  const eventJson = await Bun.stdin.text();
  let event: { toolName: string; toolArgs: string; cwd: string; timestamp: number; sessionId?: string };

  try {
    event = JSON.parse(eventJson);
  } catch {
    // Can't parse input — allow the tool call
    process.exit(0);
  }

  // FILTER: Only intercept exit_plan_mode
  if (event.toolName !== "exit_plan_mode") {
    process.exit(0); // No output = allow
  }

  // Find plan.md content (sessionId primary, newest plan.md fallback)
  const planContent = findCopilotPlanContent(event.sessionId);

  if (!planContent) {
    // No plan.md found — allow exit_plan_mode to proceed normally
    process.exit(0);
  }

  const outcome = await runDaemonSessionRequest({
    action: "plan",
    origin: "copilot-cli",
    cwd: event.cwd || getInvocationCwd(),
    plan: planContent,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
  });
  const result = outcome.result as { approved?: boolean; feedback?: string; prompt?: string };

  // Output Copilot CLI permission decision format
  if (result.approved) {
    console.log(JSON.stringify({
      permissionDecision: "allow",
    }));
  } else {
    console.log(JSON.stringify({
      permissionDecision: "deny",
      permissionDecisionReason: result.prompt ?? result.feedback ?? "Plan changes requested",
    }));
  }

  process.exit(0);

} else if (args[0] === "copilot-last") {
  // ============================================
  // COPILOT CLI ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = getInvocationCwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Copilot CLI detected, finding session for CWD: ${projectRoot}`);
  }

  const sessionDir = findCopilotSessionForCwd(projectRoot);

  if (!sessionDir) {
    console.error("No Copilot CLI session found.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Session dir: ${sessionDir}`);
  }

  const msg = getLastCopilotMessage(sessionDir);
  if (!msg) {
    console.error("No assistant message found in Copilot CLI session.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message (${msg.text.length} chars)`);
  }

  const outcome = await runDaemonSessionRequest({
    action: "annotate-last",
    origin: "copilot-cli",
    cwd: projectRoot,
    markdown: msg.text,
    filePath: "last-message",
    mode: "annotate-last",
    gate: gateFlag,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
  });

  emitAnnotateOutcome(outcome.result as { feedback: string; prompt?: string; exit?: boolean; approved?: boolean });
  process.exit(0);

} else if (args[0] === "improve-context") {
  // ============================================
  // IMPROVEMENT HOOK CONTEXT INJECTION MODE
  // ============================================
  //
  // Called by PreToolUse hook on EnterPlanMode.
  // Daemon composes any enabled context sources (compound improvement hook,
  // PFM reminder) into a single additionalContext payload.
  // Nothing enabled = exit 0 silently (passthrough).

  await Bun.stdin.text();

  let context: string | null = null;
  try {
    const client = await ensureDaemonClient({ bestEffort: true });
    const data = await client.getJson("/daemon/improve-context") as { ok: boolean; context: string | null };
    context = data.context;
  } catch {
    // Daemon unavailable — silently pass through
  }

  if (!context) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  }));

  process.exit(0);

} else {
  // ============================================
  // PLAN REVIEW MODE (default)
  // ============================================

  // Read hook event from stdin
  const eventJson = await Bun.stdin.text();
  if (!eventJson.trim()) {
    process.exit(0);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(eventJson);
  } catch (e: any) {
    console.error(`Failed to parse hook event from stdin: ${e?.message || e}`);
    process.exit(1);
  }

  if (event.hook_event_name === "Stop") {
    const rolloutPath =
      (typeof event.transcript_path === "string" && event.transcript_path) ||
      (process.env.CODEX_THREAD_ID
        ? findCodexRolloutByThreadId(process.env.CODEX_THREAD_ID)
        : null);

    if (!rolloutPath || !existsSync(rolloutPath)) {
      process.exit(0);
    }

    const latestPlan = getLatestCodexPlan(rolloutPath, {
      turnId: typeof event.turn_id === "string" ? event.turn_id : undefined,
      stopHookActive: !!event.stop_hook_active,
    });

    if (!latestPlan?.text) {
      process.exit(0);
    }

    const outcome = await runDaemonSessionRequest({
      action: "plan",
      origin: "codex",
      cwd: getInvocationCwd(),
      plan: latestPlan.text,
      sharingEnabled,
      shareBaseUrl,
      pasteApiUrl,
    });
    const result = outcome.result as { approved?: boolean; feedback?: string; prompt?: string };

    if (result.approved) {
      console.log("{}");
    } else {
      console.log(
        JSON.stringify({
          decision: "block",
          reason: result.prompt ?? result.feedback ?? "Plan changes requested",
        })
      );
    }

    process.exit(0);
  }

  let planContent = "";
  let permissionMode = "default";
  let isGemini = false;
  let planFilename = "";

  // Detect harness: Gemini sends plan_filename (file on disk), Claude Code sends plan (inline)
  planFilename = event.tool_input?.plan_filename || event.tool_input?.plan_path || "";
  isGemini = !!planFilename;

  if (isGemini) {
    // Reconstruct full plan path from transcript_path and session_id:
    // transcript_path = <projectTempDir>/chats/session-...json
    // plan lives at   = <projectTempDir>/<session_id>/plans/<plan_filename>
    const projectTempDir = path.dirname(path.dirname(event.transcript_path));
    const planFilePath = path.join(projectTempDir, event.session_id, "plans", planFilename);
    planContent = await Bun.file(planFilePath).text();
  } else {
    planContent = event.tool_input?.plan || "";
  }

  permissionMode = event.permission_mode || "default";

  if (!planContent) {
    console.error("No plan content in hook event");
    process.exit(1);
  }

  const outcome = await runDaemonSessionRequest({
    action: "plan",
    origin: isGemini ? "gemini-cli" : detectedOrigin,
    cwd: getInvocationCwd(),
    plan: planContent,
    planFilePath: planFilename || undefined,
    permissionMode,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
  });
  const result = outcome.result as {
    approved?: boolean;
    feedback?: string;
    prompt?: string;
    permissionMode?: string;
  };

  // Output decision in the appropriate format for the harness
  if (isGemini) {
    if (result.approved) {
      console.log(result.feedback ? JSON.stringify({ systemMessage: result.feedback }) : "{}");
    } else {
      console.log(
        JSON.stringify({
          decision: "deny",
          reason: result.prompt ?? result.feedback ?? "Plan changes requested",
        })
      );
    }
  } else {
    // Claude Code: PermissionRequest hook decision
    if (result.approved) {
      const updatedPermissions = [];
      if (result.permissionMode) {
        updatedPermissions.push({
          type: "setMode",
          mode: result.permissionMode,
          destination: "session",
        });
      }

      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              ...(updatedPermissions.length > 0 && { updatedPermissions }),
            },
          },
        })
      );
    } else {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "deny",
              message: result.prompt ?? result.feedback ?? "Plan changes requested",
            },
          },
        })
      );
    }
  }

  process.exit(0);
}
