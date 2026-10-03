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
}

export interface CliReviewOutcome {
  decision?: "approved" | "dismissed" | "annotated";
  approved?: boolean;
  feedback?: string;
  agentSwitch?: string;
  isPRMode?: boolean;
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
  onServer?: (metadata: { port: number; isRemote: boolean }) => void,
): void {
  if (!existsSync(readyFile)) return;

  const contents = readFileSync(readyFile, "utf-8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const metadata = JSON.parse(line) as { url?: string; port?: unknown; isRemote?: unknown };
      if (!metadata.url || loggedUrls.has(metadata.url)) continue;
      if (typeof metadata.port === "number") {
        onServer?.({ port: metadata.port, isRemote: metadata.isRemote === true });
      }
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
  const onServer = ({ port, isRemote }: { port: number; isRemote: boolean }) => {
    // The server keeps the bridge off in remote mode; nothing to poll there.
    if (!sessionBridge || !bridgeToken || bridgeClientStarted || isRemote) return;
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

export function buildAnnotateCliArgs(parsed: ParsedAnnotateArgs): string[] {
  const args = ["annotate", parsed.rawFilePath, "--json"];
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
}): Promise<OpenCodePlanReviewResult> {
  const result = await runPlannotatorCli({
    client: input.client,
    args: ["opencode-plan"],
    sessionBridge: input.sessionBridge,
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

  return {
    message: outcome.isPRMode
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
    | { kind: "file"; fileHeader: "File" | "Folder"; filePath: string }
    | { kind: "message" },
): string | null {
  if (outcome.decision === "dismissed" || !outcome.feedback?.trim()) return null;
  if (outcome.decision !== "annotated" && outcome.decision !== "approved") return null;

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
}): Promise<void> {
  const cwd = input.cwd ?? process.cwd();
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
        logAndToastError(input.client, `[Plannotator] ${error instanceof Error ? error.message : String(error)}`);
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
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
        // >= 0.27.11 answers "Unknown command"; older binaries fall into the
        // plan hook path and answer "No plan content in hook event".
        if (directoryTarget && /unknown (?:subcommand|command)|no plan content in hook event/i.test(result.stderr)) {
          logAndToastError(input.client, "Update the Plannotator CLI to review a directory from OpenCode.");
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
        await injectSessionPrompt(input.client, input.sessionId, prompt.message, {
          agent: targetAgent,
        });
      }
      return;
    }

    if (input.command === "plannotator-annotate") {
      const parsed = parseAnnotateArgs(input.rawArgs);
      if (!parsed.filePath) {
        log(input.client, "error", "Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--gate] [--json]");
        return;
      }
      if (!canLaunchGatedAnnotate(parsed, input.sessionId)) {
        log(input.client, "error", "No active session.");
        return;
      }

      const result = await runPlannotatorCli({
        client: input.client,
        args: buildAnnotateCliArgs(parsed),
        cwd,
        readyLabel: "annotation UI",
        bridge: input.bridge,
        sessionBridge: sessionBridge(),
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliAnnotateOutcome>(result.stdout);
      const prompt = buildAnnotatePromptFromBridgeOutcome(outcome, {
        kind: "file",
        fileHeader: getAnnotateFileHeader(parsed.filePath, input.cwd),
        filePath: parsed.filePath,
      });
      if (prompt && input.sessionId) {
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
          prompt,
          { agent },
        );
      }
      return;
    }

    if (input.command === "plannotator-last") {
      if (!input.sessionId) {
        log(input.client, "error", "No active session.");
        return;
      }

      const recentMessages = await getRecentAssistantMessages(input.client, input.sessionId);
      if (recentMessages.length === 0) {
        log(input.client, "error", "No assistant message found in session.");
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
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
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
          prompt,
          { agent },
        );
      }
      return;
    }

  } catch (error) {
    log(input.client, "error", `[Plannotator] ${error instanceof Error ? error.message : String(error)}`);
    if (isOpenCodePromptDeliveryError(error)) throw error;
  } finally {
    ownedBridge?.dispose?.();
  }
}
