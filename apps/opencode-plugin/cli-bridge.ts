import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SessionBridge } from "@plannotator/ai/session-bridge";
import {
  SESSION_BRIDGE_HOST_ENV,
  SESSION_BRIDGE_MODES_ENV,
  SESSION_BRIDGE_TOKEN_ENV,
} from "@plannotator/ai/session-bridge-pull";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import { parseAnnotateArgs, type ParsedAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  annotateInputNamesExistingTarget,
  annotatePathExists,
  buildMissingAnnotateFilesMessage,
  probeAnnotateBundlePath,
  probeAnnotateToken,
  selectAnnotateTokenTarget,
} from "@plannotator/shared/annotate-target";
import { annotateBundleTargetText } from "@plannotator/shared/annotate-bundle";
import {
  isOlderCliBundleRefusal,
  PLANNOTATOR_OUTCOME_REVIEW_POSTED,
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  plannotatorDecisionHeading,
  plannotatorDecisionSubject,
} from "@plannotator/shared/plannotator-tool";
import { parseReviewArgs, resolveReviewTarget } from "@plannotator/shared/review-args";
import {
  composeReviewApprovedMessage,
  getAnnotateApprovedWithNotesPrompt,
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
  getReviewDeniedSuffix,
} from "@plannotator/shared/prompts";
import {
  resolveTargetAgent,
  resolveValidatedTargetAgent,
  type OpenCodeAgentModel,
} from "./agent-switch";
import {
  deliverOpenCodePrompt,
  isOpenCodePromptDeliveryError,
} from "./prompt-delivery-error";
import {
  readLastUserAgent,
  readMessageAgent,
  resolveAddressableAgent,
  resolveAnnotatedMessageAgent,
} from "./message-agent";

type LogLevel = "info" | "error";

interface OpenCodeClient {
  app?: {
    log?: (entry: { level: LogLevel; message: string }) => unknown;
    agents?: (input?: unknown) => Promise<{ data?: OpenCodeBridgeAgent[] }>;
  };
  tui?: {
    showToast?: (input: unknown) => unknown;
  };
  /**
   * Host-provided visible delivery for a session URL, preferred over the toast
   * when present. OpenCode 1 clients carry none and keep the toast unchanged;
   * OpenCode 2's bridge client supplies one because it has no `tui` domain
   * (see `createSessionUrlNotifier` in `v2-client.ts`).
   */
  notifyUrl?: (input: { url: string; message: string }) => unknown;
  session?: {
    messages?: (input: unknown) => Promise<{ data?: any[] }>;
    prompt?: (input: unknown) => Promise<unknown>;
  };
}

export interface OpenCodePlanReviewResult {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  /** The reviewer only answered the plan's questions (absent from older binaries). */
  answersOnly?: boolean;
}

export interface OpenCodeBridgeAgent {
  name: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  /** Model configured for this agent, when the host reports one. */
  model?: OpenCodeAgentModel;
}

export interface OpenCodeBridgeContext {
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  agents?: OpenCodeBridgeAgent[];
  /**
   * The host can register the `plannotator` agent tool (OpenCode 2 with a tool
   * domain). The child CLI then advertises the tool's switch; without it the
   * reviews it opens offer none (PLANNOTATOR_OPENCODE_TOOL_CAPABLE).
   */
  toolCapable?: boolean;
}

interface RunCliOptions {
  client: OpenCodeClient;
  args: string[];
  cwd?: string;
  input?: string;
  readyLabel: string;
  extraEnv?: Record<string, string | undefined>;
  bridge?: OpenCodeBridgeContext;
  abortSignal?: AbortSignal;
  /**
   * "Ask this session": a bridge to the OpenCode session that ran the command.
   * The CLI server reaches it through the pull protocol: it gets a fresh token
   * in its environment, and once it is listening this process long-polls it.
   */
  sessionBridge?: SessionBridge;
  /** What a host tracking this launch learns while it runs (the `plannotator` tool's list/close). */
  observer?: CliLaunchObserver;
}

/**
 * What a host that tracks a launch (the `plannotator` tool's `list` and
 * `close`, `plannotator-tool.ts`) learns about the CLI child while it runs.
 */
export interface CliLaunchObserver {
  /**
   * The child started. `token` is the per-launch secret its server accepts on
   * the host-control endpoints (`/api/host/status`, `/api/host/close`): the
   * pull-bridge token, so undefined when the launch has no session bridge.
   * `terminate` sends the child SIGTERM and answers whether it was still
   * running; it is the older-CLI close fallback, never a first resort.
   */
  onSpawn?: (info: { pid: number | undefined; token: string | undefined; terminate: () => boolean }) => void;
  /**
   * The server is up (from the ready file). `port` is absent from a CLI that
   * does not write it; `target` (what the server shows, in full) from a CLI
   * older than the field.
   */
  onServer?: (info: { url: string; port?: number; isRemote: boolean; target?: string | string[] }) => void;
}

/** A launch a host tracks: the observer, plus what its decision message names. */
export interface CliLaunch extends CliLaunchObserver {
  /** The `pn-` session id the decision message's first line names. */
  sessionId: string;
  /** What the review shows, as that line names it (`notes.md`, `PR #12`, `local changes`). */
  subject: string;
  /**
   * What the review shows, in full, once its server named it (the ready
   * file): the fallback for the decision's `Target:` line when the CLI's
   * record carries none.
   */
  readonly target?: string | string[];
  /**
   * Deliver a bare approval as a message. A gate the agent opened itself (the
   * tool's `gate: true`) was told to wait for the sign-off; a slash command's
   * bare approval still sends nothing.
   */
  deliverApproval?: boolean;
  /** The command could not open the review: a refused argument or the CLI's startup error. */
  onFailure?: (message: string) => void;
  /**
   * The agent closed this review itself. An older CLI it stopped with SIGTERM
   * exits without a decision, which is then the close, not a failure.
   */
  isClosedByAgent?: () => boolean;
}

interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface CliSpawnConfig {
  command: string;
  args: string[];
  shell: false;
}

export interface CliAnnotateOutcome {
  decision?: "approved" | "dismissed" | "annotated";
  feedback?: string;
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
  /** A Done with nothing to send (#1701): `feedback` is the zero-state
   *  sentence, and no turn is started. Absent from an older CLI. */
  nothingToSend?: boolean;
  /** How many annotations the decision carried (absent from an older CLI). */
  annotationCount?: number;
  /** What was annotated, in full, as the CLI resolved it (absent from an older CLI and for the last message). */
  target?: string | string[];
}

export interface CliReviewOutcome {
  /** How many annotations the decision carried (absent from an older CLI). */
  annotationCount?: number;
  decision?: "approved" | "dismissed" | "annotated";
  approved?: boolean;
  feedback?: string;
  agentSwitch?: string;
  isPRMode?: boolean;
  /** The PR-platform status post (always a boolean from a CLI that knows it; absent from an older one). */
  platform?: boolean;
  /** What was reviewed, in full: the PR URL, patch file or directory (absent from an older CLI). */
  target?: string;
}

/** A well-formed target from a CLI record or ready line, or undefined. */
export function cliTargetOf(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "")) {
    return value as string[];
  }
  return undefined;
}

export interface RecentAssistantMessage {
  messageId: string;
  text: string;
  timestamp?: string;
  /**
   * The agent that wrote the message (#1612). Plugin-side only: it decides who
   * answers the feedback and is never sent to the CLI.
   */
  agent?: string;
}

function log(client: OpenCodeClient, level: LogLevel, message: string): void {
  try {
    void client.app?.log?.({ level, message });
  } catch {
    // OpenCode logging is best-effort.
  }
}

function getPlannotatorBin(): string {
  return process.env.PLANNOTATOR_BIN?.trim() || "plannotator";
}

const TOAST_URL_RE = /https?:\/\/\S+/;

// client.app.log only reaches OpenCode's server log file — it is never shown
// in the TUI, and on OpenCode 2 it is a console.error the host discards
// outright. Remote users, who get no auto-opened browser, therefore never saw
// the session URL. Any URL-bearing message must ALSO go through a VISIBLE
// surface: tui.showToast on OpenCode 1, and client.notifyUrl on OpenCode 2,
// whose server-plugin context has no tui domain at all. Best-effort on both: a
// host without the /tui/show-toast endpoint, or without any way to notify,
// just no-ops. `toastedUrls` dedupes across the two delivery paths (stderr
// forwarder + ready-file poller) so one session never stacks two notices for
// the same URL.
function toastPlannotatorUrl(client: OpenCodeClient, message: string, toastedUrls: Set<string>): void {
  const url = TOAST_URL_RE.exec(message)?.[0];
  if (!url || toastedUrls.has(url)) return;
  toastedUrls.add(url);
  try {
    const notify = client.notifyUrl;
    const result = typeof notify === "function"
      ? notify({ url, message })
      : (client as any).tui?.showToast?.({
        body: { title: "Plannotator", message, variant: "info" },
      });
    // A fetch-level failure (host restarting) rejects the SDK promise; swallow
    // it so a cosmetic notice can never surface an unhandled rejection — but
    // un-mark the URL so the other delivery path (stderr forwarder vs
    // ready-file poller) can still attempt one, and leave a log trail.
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        toastedUrls.delete(url);
        log(client, "info", `[Plannotator] URL delivery failed for ${url}`);
      });
    }
  } catch {
    // Visible URL delivery is best-effort.
  }
}

// A refused review target must be SEEN: `log` alone never reaches the TUI, so
// the command would appear to do nothing. Same best-effort toast surface as
// `toastPlannotatorUrl` (OpenCode 2 has no `tui` domain and keeps the log).
function logAndToastError(client: OpenCodeClient, message: string): void {
  log(client, "error", message);
  try {
    const result = client.tui?.showToast?.({
      body: { title: "Plannotator", message, variant: "error" },
    }) as { catch?: (onRejected: () => void) => unknown } | undefined;
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Toast delivery is best-effort.
  }
}

function getWindowsPathCandidates(bin: string, env: NodeJS.ProcessEnv): string[] {
  if (path.extname(bin)) return [bin];

  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  // The Windows installer ships plannotator.exe. Avoid auto-resolving .cmd/.bat
  // shims because those require cmd.exe and would reintroduce shell tokenization.
  const executableExtensions = extensions.filter((ext) => ext !== ".cmd" && ext !== ".bat");
  const preferred = [".exe", ".com"];
  const orderedExtensions = [
    ...preferred.filter((ext) => executableExtensions.includes(ext)),
    ...executableExtensions.filter((ext) => !preferred.includes(ext)),
  ];

  return [...orderedExtensions.map((ext) => `${bin}${ext}`), bin];
}

export function resolveWindowsCliCommand(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH || "";
  if (!pathValue) return undefined;

  const candidates = getWindowsPathCandidates(bin, env);
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }

  return undefined;
}

export function buildCliSpawnConfig(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CliSpawnConfig {
  if (platform === "win32" && !path.isAbsolute(bin)) {
    return {
      command: resolveWindowsCliCommand(bin, env) || bin,
      args,
      shell: false,
    };
  }

  return { command: bin, args, shell: false };
}

function parseLastJson<T>(stdout: string): T {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    return JSON.parse(line) as T;
  }
  throw new Error("Plannotator CLI did not return JSON.");
}

export function buildCliBridgeEnv(
  bridge: OpenCodeBridgeContext | undefined,
): Record<string, string | undefined> {
  return {
    ...(bridge?.sharingEnabled !== undefined && {
      PLANNOTATOR_SHARE: bridge.sharingEnabled ? "enabled" : "disabled",
    }),
    ...(bridge?.shareBaseUrl && { PLANNOTATOR_SHARE_URL: bridge.shareBaseUrl }),
    ...(bridge?.pasteApiUrl && { PLANNOTATOR_PASTE_URL: bridge.pasteApiUrl }),
    // Kept literal (packages/server's OPENCODE_TOOL_CAPABLE_ENV): this module
    // must not pull the server package into the plugin bundle.
    ...(bridge?.toolCapable && { PLANNOTATOR_OPENCODE_TOOL_CAPABLE: "1" }),
  };
}

function buildBridgePayload(bridge: OpenCodeBridgeContext | undefined): OpenCodeBridgeContext {
  return {
    ...(bridge?.sharingEnabled !== undefined && { sharingEnabled: bridge.sharingEnabled }),
    ...(bridge?.shareBaseUrl && { shareBaseUrl: bridge.shareBaseUrl }),
    ...(bridge?.pasteApiUrl && { pasteApiUrl: bridge.pasteApiUrl }),
    ...(bridge?.agents && { agents: bridge.agents }),
  };
}

function logCliWarnings(client: OpenCodeClient, stderr: string): void {
  const warningLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line));

  for (const line of warningLines) {
    log(client, "info", `[Plannotator] ${line}`);
  }
}

export function formatUserFacingCliStderrLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^Open this link on your local machine to\b/.test(trimmed)) return trimmed;
  // Current binary phrasing ("Plannotator session ready — open on your local
  // machine (forward port N if needed):"); the older "Open this link" match is
  // kept for users running an older plannotator binary.
  if (/^Plannotator session ready\b/.test(trimmed)) return trimmed;
  if (/^https?:\/\/\S+/.test(trimmed)) return trimmed;
  if (/^\(.+annotations added in browser\)$/.test(trimmed)) return trimmed;
  return undefined;
}

/**
 * Exported for tests: the stderr forwarder is one of the two paths a session
 * URL reaches the user by, and both route through `toastPlannotatorUrl`.
 */
export function createCliStderrForwarder(client: OpenCodeClient, toastedUrls: Set<string>) {
  let pending = "";
  const forwarded = new Set<string>();

  const forwardLine = (line: string) => {
    const message = formatUserFacingCliStderrLine(line);
    if (!message || forwarded.has(message)) return;
    forwarded.add(message);
    log(client, "info", `[Plannotator] ${message}`);
    toastPlannotatorUrl(client, message, toastedUrls);
  };

  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) forwardLine(line);
    },
    flush() {
      if (!pending) return;
      forwardLine(pending);
      pending = "";
    },
  };
}

function logReadyFile(
  client: OpenCodeClient,
  readyFile: string,
  readyLabel: string,
  loggedUrls: Set<string>,
  toastedUrls: Set<string>,
  onServer?: (metadata: { url: string; port?: number; isRemote: boolean; target?: string | string[] }) => void,
): void {
  if (!existsSync(readyFile)) return;

  const contents = readFileSync(readyFile, "utf-8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const metadata = JSON.parse(line) as { url?: string; port?: unknown; isRemote?: unknown; target?: unknown };
      if (!metadata.url || loggedUrls.has(metadata.url)) continue;
      const target = cliTargetOf(metadata.target);
      onServer?.({
        url: metadata.url,
        ...(typeof metadata.port === "number" ? { port: metadata.port } : {}),
        isRemote: metadata.isRemote === true,
        ...(target !== undefined ? { target } : {}),
      });
      loggedUrls.add(metadata.url);
      log(client, "info", `[Plannotator] Open ${readyLabel}: ${metadata.url}`);
      toastPlannotatorUrl(client, `Open ${readyLabel}: ${metadata.url}`, toastedUrls);
    } catch {
      // Ignore partial lines while the child process is writing.
    }
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function signalChildProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  detached: boolean,
): void {
  if (detached && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (getErrorCode(error) !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

/** The `pn-` id of a tracked launch's observer (a plain observer has none). */
function reviewIdOf(observer: CliLaunchObserver | undefined): string | undefined {
  const id = (observer as Partial<CliLaunch> | undefined)?.sessionId;
  return typeof id === "string" && /^pn-[0-9a-f]{6}$/.test(id) ? id : undefined;
}

async function runPlannotatorCli(options: RunCliOptions): Promise<RunCliResult> {
  options.abortSignal?.throwIfAborted();
  const readyFile = path.join(
    tmpdir(),
    `plannotator-opencode-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`,
  );
  const loggedUrls = new Set<string>();
  const toastedUrls = new Set<string>();
  const cwd = options.cwd ?? process.cwd();
  const sessionBridge = options.sessionBridge;
  const bridgeToken = sessionBridge ? randomBytes(32).toString("base64url") : undefined;
  const bridgeClient = new AbortController();
  let bridgeClientStarted = false;
  // The server is up: start answering its "Ask this session" questions.
  const onServer = (metadata: { url: string; port?: number; isRemote: boolean; target?: string | string[] }) => {
    try {
      options.observer?.onServer?.(metadata);
    } catch {
      // An observer never breaks the launch.
    }
    const { port, isRemote } = metadata;
    // The server keeps the bridge off in remote mode; nothing to poll there.
    if (port === undefined || !sessionBridge || !bridgeToken || bridgeClientStarted || isRemote) return;
    bridgeClientStarted = true;
    void runPullSessionBridgeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: bridgeToken,
      bridge: sessionBridge,
      signal: bridgeClient.signal,
      log: (message) => log(options.client, "info", message),
    }).catch((error) => {
      log(options.client, "info", `[Plannotator] Session bridge stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const env = {
    ...process.env,
    ...options.extraEnv,
    ...buildCliBridgeEnv(options.bridge),
    OPENCODE: "1",
    PLANNOTATOR_ORIGIN: "opencode",
    PLANNOTATOR_CWD: cwd,
    PLANNOTATOR_READY_FILE: readyFile,
    // A tracked launch's pn- id, for the CLI's `sessions/` registry.
    ...(reviewIdOf(options.observer) ? { PLANNOTATOR_HOST_REVIEW_ID: reviewIdOf(options.observer) } : {}),
    ...(sessionBridge && bridgeToken
      ? {
          [SESSION_BRIDGE_TOKEN_ENV]: bridgeToken,
          [SESSION_BRIDGE_HOST_ENV]: "opencode",
          [SESSION_BRIDGE_MODES_ENV]: [
            sessionBridge.modes.turn ? "turn" : "",
            sessionBridge.modes.transient ? "transient" : "",
          ].filter(Boolean).join(","),
        }
      : {}),
  };

  const bin = getPlannotatorBin();
  const spawnConfig = buildCliSpawnConfig(bin, options.args);
  log(options.client, "info", `[Plannotator] Starting ${options.readyLabel}...`);

  const abortSignal = options.abortSignal;
  const detached = abortSignal !== undefined && process.platform !== "win32";
  let child: ReturnType<typeof spawn> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let stderrForwarder: ReturnType<typeof createCliStderrForwarder> | undefined;

  try {
    return await new Promise<RunCliResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let processError: NodeJS.ErrnoException | undefined;
      let aborted = false;

      const requestTermination = () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        try {
          signalChildProcess(child, "SIGTERM", detached);
        } catch (error) {
          processError = error instanceof Error ? error : new Error(String(error));
        }
        if (forceKillTimer !== undefined) return;
        forceKillTimer = setTimeout(() => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          try {
            signalChildProcess(child, "SIGKILL", detached);
          } catch {
            // The close/error handlers report the original termination failure.
          }
        }, 1000);
      };

      child = spawn(spawnConfig.command, spawnConfig.args, {
        cwd,
        env,
        shell: spawnConfig.shell,
        stdio: ["pipe", "pipe", "pipe"],
        detached,
      });
      const spawned = child;
      try {
        options.observer?.onSpawn?.({
          pid: spawned.pid,
          token: bridgeToken,
          terminate: () => {
            if (spawned.exitCode !== null || spawned.signalCode !== null) return false;
            try {
              return spawned.kill("SIGTERM");
            } catch {
              return false;
            }
          },
        });
      } catch {
        // An observer never breaks the launch.
      }
      stderrForwarder = createCliStderrForwarder(options.client, toastedUrls);
      interval = setInterval(
        () => logReadyFile(options.client, readyFile, options.readyLabel, loggedUrls, toastedUrls, onServer),
        250,
      );

      if (!child.stdin || !child.stdout || !child.stderr) {
        processError = new Error("Failed to open pipes for the plannotator CLI process.");
        requestTermination();
      } else {
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          stderrForwarder?.push(chunk);
        });
        child.stdin.once("error", (error: NodeJS.ErrnoException) => {
          processError ??= error;
          requestTermination();
        });
        child.stdin.end(options.input ?? "");
      }

      child.once("error", (error: NodeJS.ErrnoException) => {
        processError ??= error;
        requestTermination();
      });
      child.once("close", (exitCode) => {
        if (aborted && abortSignal) {
          reject(getAbortReason(abortSignal));
          return;
        }
        if (processError?.code === "ENOENT") {
          reject(new Error("Could not find the plannotator CLI. Install it with: curl -fsSL https://plannotator.ai/install.sh | bash"));
          return;
        }
        if (processError) {
          reject(processError);
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });

      if (abortSignal) {
        abortListener = () => {
          aborted = true;
          requestTermination();
        };
        abortSignal.addEventListener("abort", abortListener, { once: true });
        if (abortSignal.aborted) abortListener();
      }
    });
  } finally {
    bridgeClient.abort();
    if (interval !== undefined) clearInterval(interval);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (abortSignal && abortListener) abortSignal.removeEventListener("abort", abortListener);
    stderrForwarder?.flush();
    try {
      logReadyFile(options.client, readyFile, options.readyLabel, loggedUrls, toastedUrls);
    } catch {
      // Ready metadata is best-effort during child teardown.
    }
    rmSync(readyFile, { force: true });
  }
}

/**
 * The files of a review of several files, when the user's annotate words are
 * several existing file paths (every word one; the shared bundle rule), as
 * absolute paths in the typed order; null otherwise. Each becomes its own CLI
 * argument, which is what makes the CLI open them as one review.
 */
export function annotateBundleCliPaths(rawFilePath: string, cwd: string): string[] | { missing: string[] } | null {
  if (annotateInputNamesExistingTarget(rawFilePath, cwd)) return null;
  const selection = selectAnnotateTokenTarget(
    rawFilePath,
    (token) => probeAnnotateToken(token, cwd, { bareDirectories: false }),
    { bundlePath: (token) => probeAnnotateBundlePath(token, cwd), pathExists: (token) => annotatePathExists(token, cwd) },
  );
  // A list of file paths with one that does not exist is refused before the
  // CLI runs, so it never opens fewer files than were named.
  if (selection.kind === "missing") return { missing: selection.missing };
  return selection.kind === "bundle" ? selection.files.map((file) => file.value) : null;
}

export function buildAnnotateCliArgs(parsed: ParsedAnnotateArgs, bundlePaths?: readonly string[] | null): string[] {
  const args = ["annotate", ...(bundlePaths && bundlePaths.length > 1 ? bundlePaths : [parsed.rawFilePath]), "--json"];
  if (parsed.gate) args.push("--gate");
  if (parsed.renderHtml) args.push("--render-html");
  if (parsed.renderMarkdown) args.push("--markdown");
  if (parsed.noJina) args.push("--no-jina");
  return args;
}

export function canLaunchGatedAnnotate(
  parsed: Pick<ParsedAnnotateArgs, "gate">,
  sessionId: string | undefined,
): boolean {
  return !parsed.gate || Boolean(sessionId);
}

export async function runCliPlanReview(input: {
  client: OpenCodeClient;
  planContent: string;
  cwd?: string;
  timeoutSeconds: number | null;
  abortSignal?: AbortSignal;
  bridge?: OpenCodeBridgeContext;
  /** "Ask this session" (quick answers while the plan waits). */
  sessionBridge?: SessionBridge;
  /** The tool's `list` learns the plan review's url from here. */
  observer?: CliLaunchObserver;
}): Promise<OpenCodePlanReviewResult> {
  const result = await runPlannotatorCli({
    client: input.client,
    args: ["opencode-plan"],
    sessionBridge: input.sessionBridge,
    observer: input.observer,
    cwd: input.cwd,
    input: JSON.stringify({
      plan: input.planContent,
      timeoutSeconds: input.timeoutSeconds,
      ...buildBridgePayload(input.bridge),
    }),
    readyLabel: "plan review",
    bridge: input.bridge,
    abortSignal: input.abortSignal,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
  }

  logCliWarnings(input.client, result.stderr);
  return parseLastJson<OpenCodePlanReviewResult>(result.stdout);
}

export async function injectSessionPrompt(
  client: OpenCodeClient,
  sessionId: string | undefined,
  text: string,
  options?: { agent?: string; noReply?: boolean },
): Promise<void> {
  if (!sessionId || !text.trim()) return;
  await deliverOpenCodePrompt({
    client,
    prompt: {
      path: { id: sessionId },
      body: {
        ...(options?.agent && { agent: options.agent }),
        ...(options?.noReply && { noReply: true }),
        parts: [{ type: "text", text }],
      },
    },
    failureMessage: "Could not deliver Plannotator feedback to the OpenCode session.",
  });
}

export async function getRecentAssistantMessages(
  client: OpenCodeClient,
  sessionId: string,
  limit = 25,
): Promise<RecentAssistantMessage[]> {
  const messagesResponse = await client.session?.messages?.({
    path: { id: sessionId },
  });
  const messages = messagesResponse?.data;
  if (!messages) return [];

  const recentMessages: RecentAssistantMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (recentMessages.length >= limit) break;
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    const textParts = (msg.parts ?? [])
      .filter((part: any) => part.type === "text" && part.text?.trim())
      .map((part: any) => part.text);
    if (textParts.length === 0) continue;
    const agent = readMessageAgent(msg.info);
    recentMessages.push({
      messageId: msg.info?.id ?? `opencode-${i}`,
      text: textParts.join("\n"),
      timestamp: msg.info?.time?.created ? new Date(msg.info.time.created).toISOString() : undefined,
      ...(agent && { agent }),
    });
  }

  return recentMessages;
}

/** The agent of the session's latest user message, or undefined on any failure. */
async function readSessionUserAgent(
  client: OpenCodeClient,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const response = await client.session?.messages?.({ path: { id: sessionId } });
    return readLastUserAgent(response?.data);
  } catch {
    return undefined;
  }
}

/**
 * The review decision was the PR-platform status post (#1719): the CLI's
 * explicit `platform` flag; a CLI older than the flag only said `isPRMode`.
 * Never inferred from the annotation count.
 */
export function isPlatformPost(outcome: CliReviewOutcome): boolean {
  return typeof outcome.platform === "boolean" ? outcome.platform : outcome.isPRMode === true;
}

export function buildReviewPromptFromBridgeOutcome(outcome: CliReviewOutcome): {
  message: string | null;
  agent?: string;
} {
  if (outcome.decision === "dismissed") return { message: null };

  const targetAgent = resolveTargetAgent(outcome.agentSwitch);

  if (outcome.approved || outcome.decision === "approved") {
    // PR5 delivery (spec §6.4, consumer #3): the CLI's JSON record carries
    // feedback on approve; deliver it in the approved-with-notes framing
    // instead of discarding it.
    return {
      message: composeReviewApprovedMessage("opencode", outcome.feedback),
      ...(targetAgent && { agent: targetAgent }),
    };
  }

  if (!outcome.feedback?.trim()) {
    return {
      message: null,
      ...(targetAgent && { agent: targetAgent }),
    };
  }

  // The platform status post goes through verbatim; everything else the
  // reviewer sent gets the suffix. A CLI older than the `platform` field only
  // said `isPRMode`, so that stays the fallback (PR-mode feedback then keeps
  // its old suffix-less shape).
  const platformPost = isPlatformPost(outcome);
  return {
    message: platformPost
      ? outcome.feedback
      : `${outcome.feedback}${getReviewDeniedSuffix("opencode")}`,
    ...(targetAgent && { agent: targetAgent }),
  };
}

function getAnnotateFileHeader(filePath: string, cwd?: string): "File" | "Folder" {
  if (/^https?:\/\//i.test(filePath)) return "File";

  try {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd || process.cwd(), filePath);
    return statSync(resolved).isDirectory() ? "Folder" : "File";
  } catch {
    return "File";
  }
}

export function buildAnnotatePromptFromBridgeOutcome(
  outcome: CliAnnotateOutcome,
  target:
    | { kind: "file"; fileHeader: "File" | "Folder" | "Files"; filePath: string }
    | { kind: "message" },
): string | null {
  if (outcome.decision === "dismissed" || !outcome.feedback?.trim()) return null;
  if (outcome.decision !== "annotated" && outcome.decision !== "approved") return null;
  if (outcome.decision === "annotated" && outcome.nothingToSend === true) return null;

  if (outcome.decision === "approved") {
    return getAnnotateApprovedWithNotesPrompt("opencode", undefined, {
      context: target.kind === "file"
        ? `${target.fileHeader}: ${target.filePath}`
        : undefined,
      feedback: outcome.feedback,
    });
  }

  return target.kind === "message"
    ? getAnnotateMessageFeedbackPrompt("opencode", undefined, {
        feedback: outcome.feedback,
      })
    : getAnnotateFileFeedbackPrompt("opencode", undefined, {
        fileHeader: target.fileHeader,
        filePath: target.filePath,
        feedback: outcome.feedback,
      });
}

/** A session bridge the command owns for the lifetime of its CLI run. */
export type DisposableSessionBridge = SessionBridge & { dispose?: () => void };

/**
 * The first line a tracked launch's decision message carries
 * (`plannotatorDecisionHeading`): what was reviewed, its session id, and the
 * outcome, so the agent can tell which of its reviews answered.
 */
export function withDecisionHeading(
  launch: CliLaunch | undefined,
  outcome: string,
  message: string,
  /** The decision record's own target (the CLI's resolution); the launch's is the fallback. */
  recordTarget?: string | string[],
): string {
  if (!launch) return message;
  const target = cliTargetOf(recordTarget) ?? launch.target;
  // A review switched in place to another PR is named after that PR.
  const subject = plannotatorDecisionSubject(launch.subject, launch.target, target);
  const heading = plannotatorDecisionHeading(subject, launch.sessionId, outcome, target);
  return message.trim() ? `${heading}\n\n${message}` : heading;
}

/** ` · 3 comments`, or nothing for none or an unknown count (an older CLI). */
function commentsSuffix(count: number | undefined): string {
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return "";
  return ` · ${count} ${count === 1 ? "comment" : "comments"}`;
}

/** The outcome a review decision's heading names (the Claude Code mod's wording). */
export function reviewDecisionOutcome(outcome: CliReviewOutcome): string {
  const comments = commentsSuffix(outcome.annotationCount);
  if (outcome.approved || outcome.decision === "approved") {
    return outcome.feedback?.trim() ? `Approved with notes${comments}` : "Approved";
  }
  // The status post carries what was posted to the platform, not a request.
  if (isPlatformPost(outcome)) return PLANNOTATOR_OUTCOME_REVIEW_POSTED;
  return `Changes requested${comments}`;
}

/** The outcome an annotate decision's heading names (the Claude Code mod's wording). */
export function annotateDecisionOutcome(outcome: CliAnnotateOutcome): string {
  const comments = commentsSuffix(outcome.annotationCount);
  if (outcome.decision === "approved") return outcome.feedback?.trim() ? `Approved with notes${comments}` : "Approved";
  return `Feedback${comments}`;
}

export async function handleCliCommand(input: {
  command: string;
  client: OpenCodeClient;
  sessionId?: string;
  rawArgs: string;
  cwd?: string;
  bridge?: OpenCodeBridgeContext;
  /**
   * "Ask this session": builds the bridge to the invoking session. Called only
   * once the command is about to open a Plannotator UI; disposed when it ends.
   */
  createSessionBridge?: () => DisposableSessionBridge | undefined;
  /**
   * Annotate arguments already split (the `plannotator` tool, whose target is
   * one argument however many spaces it holds). Used instead of parsing
   * `rawArgs` for `plannotator-annotate`.
   */
  annotateArgs?: ParsedAnnotateArgs;
  /**
   * With `annotateArgs`: the tool's list of files (two or more), in order,
   * opened as one review. Each is its own CLI argument.
   */
  annotateBundle?: readonly string[];
  /** A launch the host tracks: its observer, failure report and decision heading. */
  launch?: CliLaunch;
}): Promise<void> {
  const cwd = input.cwd ?? process.cwd();
  const launch = input.launch;
  let ownedBridge: DisposableSessionBridge | undefined;
  const sessionBridge = (): SessionBridge | undefined => {
    if (!ownedBridge) {
      try {
        ownedBridge = input.createSessionBridge?.();
      } catch {
        ownedBridge = undefined;
      }
    }
    return ownedBridge;
  };
  // The review did not open (or its CLI failed): tell a tracking host, once.
  let failureReported = false;
  const reportFailure = (message: string) => {
    if (failureReported) return;
    failureReported = true;
    try {
      launch?.onFailure?.(message);
    } catch {
      // A tracking host never breaks the command.
    }
  };
  const cliFailure = (result: RunCliResult) => {
    if (launch?.isClosedByAgent?.()) {
      log(input.client, "info", `[Plannotator] The agent closed ${launch.subject} (${launch.sessionId}); nothing is sent for it.`);
      return;
    }
    const message = result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`;
    log(input.client, "error", message);
    reportFailure(message);
  };

  try {
    if (input.command === "plannotator-review") {
      const parsed = parseReviewArgs(input.rawArgs);
      if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
      // Older binaries ignore positional paths. A distinct internal command
      // makes version skew fail before opening a review of the wrong repo.
      // Prose that names no directory keeps the old command, so it still
      // works against an old binary exactly as before.
      let directoryTarget: string | undefined;
      try {
        directoryTarget = resolveReviewTarget(parsed, cwd).directory;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logAndToastError(input.client, `[Plannotator] ${message}`);
        reportFailure(message);
        return;
      }
      const command = directoryTarget ? "opencode-review-directory" : "opencode-review";
      const result = await runPlannotatorCli({
        client: input.client,
        args: [command],
        cwd,
        input: JSON.stringify({
          arguments: input.rawArgs,
          // Fail-closed approval-notes handshake (same version-skew reasoning
          // as formatUserFacingCliStderrLine above: the binary and this plugin
          // version independently). The advert lives in the binary's review
          // server while DELIVERY lives in this plugin's
          // buildReviewPromptFromBridgeOutcome, so the binary must advertise
          // approvalNotesSupported for opencode ONLY when the plugin declares
          // it delivers approve-time feedback. An old plugin omits the field,
          // the advert stays false, and the approve-carrying menu items never
          // render — nothing a new binary does can make an old plugin drop a
          // reviewer's note.
          supportsApprovalNotes: true,
          ...buildBridgePayload(input.bridge),
        }),
        readyLabel: "code review",
        bridge: input.bridge,
        sessionBridge: sessionBridge(),
        observer: launch,
      });
      if (result.exitCode !== 0) {
        // >= 0.27.11 answers "Unknown command"; older binaries fall into the
        // plan hook path and answer "No plan content in hook event".
        if (directoryTarget && /unknown (?:subcommand|command)|no plan content in hook event/i.test(result.stderr)) {
          log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
          const update = "Update the Plannotator CLI to review a directory from OpenCode.";
          logAndToastError(input.client, update);
          reportFailure(update);
        } else {
          cliFailure(result);
        }
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliReviewOutcome>(result.stdout);
      const prompt = buildReviewPromptFromBridgeOutcome(outcome);
      if (prompt.message) {
        const targetAgent = await resolveValidatedTargetAgent({
          client: input.client,
          targetAgent: prompt.agent,
          directory: cwd,
        });
        await injectSessionPrompt(
          input.client,
          input.sessionId,
          withDecisionHeading(launch, reviewDecisionOutcome(outcome), prompt.message, outcome.target),
          { agent: targetAgent },
        );
      }
      return;
    }

    if (input.command === "plannotator-annotate") {
      const parsed = input.annotateArgs ?? parseAnnotateArgs(input.rawArgs);
      if (!parsed.filePath) {
        const usage = "Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--gate] [--json]";
        log(input.client, "error", usage);
        reportFailure(usage);
        return;
      }
      if (!canLaunchGatedAnnotate(parsed, input.sessionId)) {
        log(input.client, "error", "No active session.");
        reportFailure("No active session.");
        return;
      }

      // Several existing file paths open as one review of all of them. The
      // tool's list arrives split (each entry one argument, never re-split,
      // checked by the CLI); a single tool target is never read as several.
      const bundleSelection = input.annotateArgs
        ? (input.annotateBundle && input.annotateBundle.length > 1 ? [...input.annotateBundle] : null)
        : annotateBundleCliPaths(parsed.rawFilePath, cwd);
      if (bundleSelection && !Array.isArray(bundleSelection)) {
        const missing = buildMissingAnnotateFilesMessage(bundleSelection.missing);
        log(input.client, "error", missing);
        reportFailure(missing);
        return;
      }
      const bundlePaths = bundleSelection;
      const result = await runPlannotatorCli({
        client: input.client,
        args: buildAnnotateCliArgs(parsed, bundlePaths),
        cwd,
        readyLabel: "annotation UI",
        bridge: input.bridge,
        sessionBridge: sessionBridge(),
        observer: launch,
      });
      if (result.exitCode !== 0) {
        // A CLI that predates reviews of several files answers with its
        // ambiguity error; say to update instead.
        if (bundlePaths && isOlderCliBundleRefusal(result.stderr.trim()) && !launch?.isClosedByAgent?.()) {
          log(input.client, "error", PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT);
          reportFailure(PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT);
        } else {
          cliFailure(result);
        }
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliAnnotateOutcome>(result.stdout);
      // The CLI's own resolution of the file (absolute) wins over the words
      // the plugin passed it: a bare name may have resolved anywhere.
      const resolvedTarget = cliTargetOf(outcome.target);
      const filePath = typeof resolvedTarget === "string" ? resolvedTarget : parsed.filePath;
      let prompt = buildAnnotatePromptFromBridgeOutcome(outcome, bundlePaths
        ? { kind: "file", fileHeader: "Files", filePath: annotateBundleTargetText(bundlePaths) }
        : {
            kind: "file",
            fileHeader: getAnnotateFileHeader(filePath, input.cwd),
            filePath,
          });
      // A gate the agent opened itself waits for the sign-off: a bare
      // approval is still a message (its heading says "Approved").
      if (prompt === null && launch?.deliverApproval && outcome.decision === "approved") prompt = "";
      if (prompt !== null && input.sessionId) {
        // No annotated message here: the agent the user is talking to reads
        // the feedback, not OpenCode's default agent (#1612).
        const agent = await resolveAddressableAgent({
          client: input.client,
          agent: await readSessionUserAgent(input.client, input.sessionId),
          directory: cwd,
        });
        await injectSessionPrompt(
          input.client,
          input.sessionId,
          withDecisionHeading(launch, annotateDecisionOutcome(outcome), prompt, outcome.target),
          { agent },
        );
      }
      return;
    }

    if (input.command === "plannotator-last") {
      if (!input.sessionId) {
        log(input.client, "error", "No active session.");
        reportFailure("No active session.");
        return;
      }

      const recentMessages = await getRecentAssistantMessages(input.client, input.sessionId);
      if (recentMessages.length === 0) {
        log(input.client, "error", "No assistant message found in session.");
        reportFailure("There is no assistant message to annotate yet.");
        return;
      }

      const parsed = parseAnnotateArgs(input.rawArgs);
      const result = await runPlannotatorCli({
        client: input.client,
        args: ["opencode-annotate-last"],
        cwd,
        input: JSON.stringify({
          gate: parsed.gate,
          recentMessages: recentMessages.map(({ agent: _agent, ...message }) => message),
          ...buildBridgePayload(input.bridge),
        }),
        readyLabel: "annotation UI",
        bridge: input.bridge,
        sessionBridge: sessionBridge(),
        observer: launch,
      });
      if (result.exitCode !== 0) {
        cliFailure(result);
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliAnnotateOutcome>(result.stdout);
      const prompt = buildAnnotatePromptFromBridgeOutcome(outcome, {
        kind: "message",
      });
      if (prompt) {
        // The agent that wrote the annotated message answers the feedback
        // (#1612); unknown or unavailable leaves the prompt unnamed as before.
        const agent = await resolveAddressableAgent({
          client: input.client,
          agent: resolveAnnotatedMessageAgent(recentMessages, outcome),
          directory: cwd,
        });
        await injectSessionPrompt(
          input.client,
          input.sessionId,
          withDecisionHeading(launch, annotateDecisionOutcome(outcome), prompt),
          { agent },
        );
      }
      return;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(input.client, "error", `[Plannotator] ${message}`);
    reportFailure(message);
    if (isOpenCodePromptDeliveryError(error)) throw error;
  } finally {
    ownedBridge?.dispose?.();
  }
}
