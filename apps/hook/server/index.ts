/**
 * Plannotator CLI for Claude Code
 *
 * Public daemon-backed commands:
 *   plannotator daemon start|stop|status
 *   plannotator start|stop|status
 *   plannotator submit [file] [--mode plan|annotate] [--no-browser] [--commit-message <msg>]
 *   plannotator review [--diff-type ...]
 *   plannotator annotate <file>
 *   plannotator wait
 *   plannotator clear [--force]
 *   plannotator open
 *
 * Default invocation with no args remains the Claude Code hook entrypoint,
 * but it now routes through the daemon-backed submit/wait flow.
 */

import { daemonStatus, getServerPort, openBrowser, startDaemonDetached, stopDaemon } from "@plannotator/server";
import { notifyDocumentEnteredReview } from "@plannotator/server/notify";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";
import { listSessions, registerSession, unregisterSession } from "@plannotator/server/sessions";
import {
  getFileContentsForDiff,
  getGitContext,
  getDefaultBranch,
  gitAddFile,
  gitResetFile,
  runGitDiff,
  type DiffType,
  validateFilePath,
} from "@plannotator/server/git";
import { detectProjectName } from "@plannotator/server/project";
import { generateSlug, getPlanVersion, getVersionCount, saveToHistory } from "@plannotator/server/storage";
import { loadState, saveState, type DaemonState, type DocumentSnapshot } from "@plannotator/server/state";
import { createDaemonRouter } from "../../../packages/server/daemon-router";
import { createDaemonEventBus } from "../../../packages/server/daemon-events";
import { handleDraftDelete, handleDraftLoad, handleDraftSave, handleImage, handleUpload } from "../../../packages/server/shared-handlers";
import { handleDoc } from "../../../packages/server/reference-handlers";
import { contentHash } from "../../../packages/server/draft";
import { getRepoInfo } from "../../../packages/server/repo";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path, { join } from "node:path";

// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };
const planHtmlContent = planHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

// @ts-ignore - Bun import attribute for json
import workspacePackageJson from "../../../package.json" with { type: "json" };
const PACKAGE_VERSION = (workspacePackageJson as { version?: string }).version ?? "0.0.0";

type VerdictPayload = {
  feedback?: {
    approved: boolean;
    feedback: string;
    annotations: Array<Record<string, unknown>>;
    agentSwitch?: string;
    permissionMode?: string;
    cancelled?: boolean;
  };
  document?: DocumentSnapshot;
  state?: DaemonState;
};

type PlanSubmitSource = {
  document: DocumentSnapshot;
  commitMessage?: string;
  permissionMode?: string;
};

type ActivePlanContext = {
  permissionMode?: string;
  previousPlan: string | null;
  versionInfo: {
    version: number;
    totalVersions: number;
    project: string;
  };
  repoInfo: Awaited<ReturnType<typeof getRepoInfo>>;
};

type ActiveReviewContext = {
  diffType: DiffType;
  cwd?: string;
  gitContext: Awaited<ReturnType<typeof getGitContext>>;
  repoInfo: Awaited<ReturnType<typeof getRepoInfo>>;
  error?: string;
};

type ActiveAnnotateContext = {
  repoInfo: Awaited<ReturnType<typeof getRepoInfo>>;
};

const EXIT_OK = 0;
const EXIT_DENIED = 1;
const EXIT_ILLEGAL_STATE = 2;
const EXIT_DAEMON_FAILURE = 3;
const EXIT_CANCELLED = 130;
const LIVENESS_TIMEOUT_MS = 10_000;
const LIVENESS_POLL_MS = 100;
const WAIT_STREAM_RETRIES = 1;
process.on("exit", () => unregisterSession());

function usageText(): string {
  return [
    "plannotator — daemon-backed plan & code review CLI",
    "",
    "Usage:",
    "  plannotator daemon start [--foreground]",
    "  plannotator daemon stop",
    "  plannotator daemon status",
    "  plannotator submit <file> [--mode plan|review|annotate] [--no-browser] [--commit-message <msg>] [--json]",
    "  plannotator review [--diff-type <uncommitted|staged|unstaged|last-commit|branch|worktree:...>] [--json]",
    "  plannotator annotate <file> [--json]",
    "  plannotator wait [--request-id <id>] [--json]",
    "  plannotator clear [--force]",
    "  plannotator open",
    "",
    "Exit codes:",
    "  0   approved or command completed successfully",
    "  1   denied, stopped daemon status, or daemon-delivered cancellation",
    "  2   collision or other illegal-state rejection",
    "  3   daemon failure or lost daemon connection after retry",
    "  130 local CLI cancellation via signal",
  ].join("\n");
}

function fail(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function getDaemonPort(): number {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
      fail(`Invalid PLANNOTATOR_PORT ${JSON.stringify(envPort)}.`, EXIT_DAEMON_FAILURE);
    }

    return parsed;
  }

  const metadata = readDaemonMetadata();
  if (metadata) {
    return metadata.port;
  }

  return 19432;
}

function getDaemonDir(): string {
  return join(homedir(), ".plannotator");
}

function getDaemonMetadataPath(): string {
  return join(getDaemonDir(), "daemon.json");
}

function readDaemonMetadata(): { port: number } | null {
  const metadataPath = getDaemonMetadataPath();
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as { port?: unknown };
    if (
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port < 65536
    ) {
      return { port: parsed.port };
    }
  } catch {}

  return null;
}

function writeDaemonMetadata(port: number): void {
  mkdirSync(getDaemonDir(), { recursive: true });
  writeFileSync(getDaemonMetadataPath(), JSON.stringify({ port }), "utf8");
}

async function allocateDaemonPort(): Promise<number> {
  const desiredPort = getServerPort();

  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(desiredPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a daemon port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function ensureDaemonPort(): Promise<number> {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    return getDaemonPort();
  }

  const metadata = readDaemonMetadata();
  if (metadata) {
    return metadata.port;
  }

  const port = await allocateDaemonPort();
  writeDaemonMetadata(port);
  return port;
}

function getDaemonUrl(port = getDaemonPort()): string {
  return `http://127.0.0.1:${port}`;
}

function getDaemonLockfilePath(): string {
  return join(getDaemonDir(), "daemon.lock");
}

function isCompiledPlannotatorEntrypoint(modulePath: string): boolean {
  return modulePath.startsWith("/$bunfs/");
}

function buildDaemonCommand(): string[] {
  const entrypointPath = fileURLToPath(import.meta.url);
  if (isCompiledPlannotatorEntrypoint(entrypointPath)) {
    return [process.execPath, "daemon", "start", "--foreground"];
  }

  return [
    process.execPath,
    "run",
    entrypointPath,
    "daemon",
    "start",
    "--foreground",
  ];
}

function daemonLaunchOptions(port: number) {
  return {
    childCommand: buildDaemonCommand(),
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLANNOTATOR_PORT: String(port),
    },
    lockfilePath: getDaemonLockfilePath(),
  };
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }

  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    fail(`Missing value for ${flag}.`, EXIT_ILLEGAL_STATE);
  }

  args.splice(index, 2);
  return value;
}

function parseCommand(argv: string[]): string[] {
  const args = [...argv];
  const browser = takeOption(args, "--browser");
  if (browser) {
    process.env.PLANNOTATOR_BROWSER = browser;
  }

  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    console.log(usageText());
    process.exit(EXIT_OK);
  }

  if (takeFlag(args, "--version") || takeFlag(args, "-V")) {
    console.log(PACKAGE_VERSION);
    process.exit(EXIT_OK);
  }

  return args;
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (await predicate()) {
      return;
    }

    await Bun.sleep(LIVENESS_POLL_MS);
  }

  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
}

async function waitForDaemonLiveness(): Promise<void> {
  const url = getDaemonUrl();
  await waitForCondition(async () => {
    try {
      const response = await fetch(`${url}/api/state`);
      return response.ok;
    } catch {
      return false;
    }
  }, LIVENESS_TIMEOUT_MS, "daemon liveness");
}

async function readDaemonStateFromHttp(): Promise<DaemonState> {
  const response = await fetch(`${getDaemonUrl()}/api/state`);
  if (!response.ok) {
    throw new Error(`Daemon /api/state returned ${response.status}.`);
  }

  return (await response.json()) as DaemonState;
}

async function withDaemon<T>(fn: () => Promise<T>): Promise<T> {
  const port = await ensureDaemonPort();
  const status = await daemonStatus(daemonLaunchOptions(port));
  if (status.verdict !== "running") {
    await startDaemonDetached(daemonLaunchOptions(port));
  }

  await waitForDaemonLiveness();
  return await fn();
}

function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }

  return null;
}

function summarizeDocument(document: DocumentSnapshot | null | undefined): string {
  if (!document) {
    return "no active document";
  }

  if (document.mode === "review") {
    return `review ${JSON.stringify(document.gitRef ?? "uncommitted diff")}`;
  }

  if (document.mode === "annotate") {
    return `annotate ${JSON.stringify(path.basename(document.filePath ?? document.id))}`;
  }

  return `plan ${JSON.stringify(firstHeading(document.content) ?? document.id)}`;
}

function documentTitle(document: DocumentSnapshot | null | undefined): string {
  if (!document) {
    return "unknown";
  }

  if (document.mode === "review") {
    return document.gitRef ?? "uncommitted diff";
  }

  if (document.mode === "annotate") {
    return path.basename(document.filePath ?? document.id);
  }

  return firstHeading(document.content) ?? document.id;
}

async function readActiveSession() {
  const sessions = listSessions();
  return sessions.find((session) => session.url === getDaemonUrl()) ?? sessions[0] ?? null;
}

async function printCollision(commandLabel: string): Promise<never> {
  let currentState: DaemonState | null = null;
  try {
    currentState = await readDaemonStateFromHttp();
  } catch {
    currentState = null;
  }

  const session = await readActiveSession();
  const document = currentState?.document ?? null;
  const startedAt = session?.startedAt ?? "unknown";
  const url = session?.url ?? getDaemonUrl();

  fail(
    [
      `409 collision: plannotator ${commandLabel} cannot replace the active submission.`,
      `Active mode: ${document?.mode ?? "unknown"}`,
      `Document: ${documentTitle(document)}`,
      `Submitted at: ${startedAt}`,
      `Current status: ${currentState?.status ?? "unknown"}`,
      `Resume URL: ${url}`,
      "Reconnect with: plannotator wait",
      "Reopen with: plannotator open",
      "To discard it: plannotator clear --force",
    ].join("\n"),
    EXIT_ILLEGAL_STATE,
  );
}

function renderHookDeny(message: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message,
        },
      },
    }),
  );
  process.exit(EXIT_OK);
}

async function printHookCollision(commandLabel: string): Promise<never> {
  const state = await readDaemonStateFromHttp().catch(() => null);
  const label = commandLabel === "submit" ? "plan submission" : commandLabel;
  const requestId = state?.document?.id;
  const details = [
    `Plannotator could not accept this ${label} because another review is already active.`,
    requestId ? `Active request ID: ${requestId}` : null,
    "Reopen with: plannotator open",
    "To fetch the active verdict: plannotator wait",
    "To discard it: plannotator clear --force",
  ].filter((line): line is string => Boolean(line));

  renderHookDeny(details.join("\n"));
}

async function openSessionUrl(url: string): Promise<void> {
  const opened = await openBrowser(url);
  if (!opened) {
    fail(`Failed to open browser for ${url}.`, EXIT_DAEMON_FAILURE);
  }
}

async function requestJson(
  pathname: string,
  init?: RequestInit,
): Promise<{ response: Response; text: string; json: Record<string, unknown> | null }> {
  const response = await fetch(`${getDaemonUrl()}${pathname}`, init);
  const text = await response.text();

  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }

  return { response, text, json };
}

function extractVerdictEvents(buffer: string): { events: VerdictPayload[]; rest: string } {
  const events: VerdictPayload[] = [];
  let remaining = buffer;

  while (true) {
    const boundary = remaining.indexOf("\n\n");
    if (boundary === -1) {
      break;
    }

    const rawEvent = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    const lines = rawEvent.split("\n");
    let eventName = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (eventName !== "verdict") {
      continue;
    }

    const rawData = dataLines.join("\n");
    try {
      events.push(JSON.parse(rawData) as VerdictPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse daemon SSE verdict payload: ${message}`);
    }
  }

  return { events, rest: remaining };
}

async function collectEventStreamEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<VerdictPayload[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  return extractVerdictEvents(buffer).events;
}

function validateStreamEvents(events: VerdictPayload[]): void {
  if (events.length === 0) {
    throw new Error("Daemon /api/wait closed without emitting a verdict event.");
  }
}

function parseStreamEvents(events: VerdictPayload[]): VerdictPayload {
  const verdict = events.at(-1);
  if (!verdict) {
    throw new Error("No verdict event was available to parse.");
  }

  return verdict;
}

async function waitForVerdict(requestId?: string): Promise<VerdictPayload> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= WAIT_STREAM_RETRIES; attempt++) {
    try {
      const waitUrl = requestId
        ? `${getDaemonUrl()}/api/wait?requestId=${encodeURIComponent(requestId)}`
        : `${getDaemonUrl()}/api/wait`;
      const response = await fetch(waitUrl);
      if (response.status === 409) {
        const body = await response.text();
        fail(body || "No active or buffered daemon verdict is available.", EXIT_ILLEGAL_STATE);
      }
      if (!response.ok) {
        throw new Error(`Daemon /api/wait returned ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`Daemon /api/wait returned ${JSON.stringify(contentType)} instead of text/event-stream.`);
      }
      if (!response.body) {
        throw new Error("Daemon /api/wait returned no readable response body.");
      }

      const events = await collectEventStreamEvents(response.body);

      validateStreamEvents(events);

      return parseStreamEvents(events);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < WAIT_STREAM_RETRIES) {
        await Bun.sleep(LIVENESS_POLL_MS);
      }
    }
  }

  const message = lastError ? `${lastError.message} (after ${WAIT_STREAM_RETRIES} retries)` : "Failed to wait for verdict.";
  fail(message, EXIT_DAEMON_FAILURE);
}

function renderPlainVerdict(payload: VerdictPayload): never {
  const feedback = payload.feedback;
  const document = payload.document;

  if (!feedback || !document) {
    fail("Daemon returned an incomplete verdict payload.", EXIT_DAEMON_FAILURE);
  }

  if (feedback.cancelled) {
    console.log(feedback.feedback || "Cancelled.");
  } else if (feedback.feedback) {
    console.log(feedback.feedback);
  }

  if (feedback.cancelled) {
    process.exit(EXIT_DENIED);
  }

  if (document.mode === "review" || document.mode === "annotate") {
    process.exit(EXIT_OK);
  }

  process.exit(feedback.approved ? EXIT_OK : EXIT_DENIED);
}

function renderJsonVerdict(payload: VerdictPayload): never {
  const feedback = payload.feedback;
  const document = payload.document;

  if (!feedback || !document) {
    fail("Daemon returned an incomplete JSON verdict payload.", EXIT_DAEMON_FAILURE);
  }

  console.log(
    JSON.stringify({
      approved: feedback.approved,
      cancelled: feedback.cancelled === true,
      feedback: feedback.feedback,
      mode: document.mode,
      agentSwitch: feedback.agentSwitch,
      permissionMode: feedback.permissionMode,
    }),
  );

  if (feedback.cancelled) {
    process.exit(EXIT_DENIED);
  }

  if (document.mode === "review" || document.mode === "annotate") {
    process.exit(EXIT_OK);
  }

  process.exit(feedback.approved ? EXIT_OK : EXIT_DENIED);
}

function renderHookVerdict(payload: VerdictPayload): never {
  const feedback = payload.feedback;
  if (!feedback) {
    fail("Daemon returned an incomplete hook verdict payload.", EXIT_DAEMON_FAILURE);
  }

  if (feedback.cancelled) {
    process.exit(EXIT_CANCELLED);
  }

  if (feedback.approved) {
    const updatedPermissions = [];
    if (feedback.permissionMode) {
      updatedPermissions.push({
        type: "setMode",
        mode: feedback.permissionMode,
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
      }),
    );
    process.exit(EXIT_OK);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: `YOUR PLAN WAS NOT APPROVED. You MUST revise the plan to address ALL of the feedback below before calling ExitPlanMode again. Do not resubmit the same plan — use the Edit tool to make targeted changes to the plan file first.\n\n${feedback.feedback || "Plan changes requested"}`,
        },
      },
    }),
  );
  process.exit(EXIT_OK);
}

async function submitDocument(
  document: DocumentSnapshot,
  options: {
    noBrowser?: boolean;
    permissionMode?: string;
    commitMessage?: string;
    submitPayload?: Record<string, unknown>;
    verdictFormat?: "plain" | "json";
  } = {},
): Promise<never> {
  await withDaemon(async () => {
    const { response, json, text } = await requestJson("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document,
        noBrowser: true, // CLI handles browser opening, not daemon
        permissionMode: options.permissionMode,
        commitMessage: options.commitMessage,
        ...options.submitPayload,
      }),
    });

    if (response.status === 409) {
      await printCollision(document.mode === "plan" ? "submit" : document.mode);
    }
    if (!response.ok) {
      fail(text || `Daemon submit failed with ${response.status}.`, EXIT_DAEMON_FAILURE);
    }

    const url = typeof json?.url === "string" ? json.url : getDaemonUrl();
    if (options.noBrowser !== true) {
      await openSessionUrl(url);
    }

    const verdict = await waitForVerdict(document.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(`${message}\nUse plannotator wait to reconnect or plannotator open to reopen the session.`, EXIT_DAEMON_FAILURE);
    });

    if (options.verdictFormat === "json") {
      renderJsonVerdict(verdict);
    }

    renderPlainVerdict(verdict);
  });

  fail("submitDocument returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function submitPlanFromHook(): Promise<never> {
  const rawEvent = await Bun.stdin.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch {
    fail("Failed to parse hook event from stdin", EXIT_ILLEGAL_STATE);
  }

  const record = parsed as {
    permission_mode?: string;
    tool_input?: { plan?: string; commit_message?: string };
  };
  const plan = record.tool_input?.plan ?? "";
  if (!plan) {
    fail("No plan content in hook event", EXIT_ILLEGAL_STATE);
  }

  const source: PlanSubmitSource = {
    document: {
      id: generateSlug(plan),
      mode: "plan",
      origin: "claude-code",
      content: plan,
    },
    permissionMode: record.permission_mode ?? "default",
    commitMessage: record.tool_input?.commit_message,
  };

  await withDaemon(async () => {
    const { response, text } = await requestJson("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: source.document,
        permissionMode: source.permissionMode,
        commitMessage: source.commitMessage,
      }),
    });

    if (response.status === 409) {
      await printHookCollision("submit");
    }
    if (!response.ok) {
      fail(text || `Daemon submit failed with ${response.status}.`, EXIT_DAEMON_FAILURE);
    }

    await openSessionUrl(getDaemonUrl());
    const verdict = await waitForVerdict(source.document.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(`${message}\nUse plannotator wait to reconnect or plannotator open to reopen the session.`, EXIT_DAEMON_FAILURE);
    });
    renderHookVerdict(verdict);
  });

  fail("submitPlanFromHook returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function resolvePlanSubmitSource(fileArg: string | undefined): Promise<PlanSubmitSource> {
  if (!fileArg) {
    const rawEvent = await Bun.stdin.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawEvent);
    } catch {
      fail("submit without <file> requires hook JSON on stdin.", EXIT_ILLEGAL_STATE);
    }

    const record = parsed as {
      permission_mode?: string;
      tool_input?: { plan?: string; commit_message?: string };
    };
    const plan = record.tool_input?.plan ?? "";
    if (!plan) {
      fail("submit without <file> requires tool_input.plan in stdin JSON.", EXIT_ILLEGAL_STATE);
    }

    return {
      document: {
        id: generateSlug(plan),
        mode: "plan",
        origin: "claude-code",
        content: plan,
      },
      permissionMode: record.permission_mode ?? "default",
      commitMessage: record.tool_input?.commit_message,
    };
  }

  const absolutePath = path.resolve(fileArg.startsWith("@") ? fileArg.slice(1) : fileArg);
  const content = await Bun.file(absolutePath).text();
  return {
    document: {
      id: generateSlug(content),
      mode: "plan",
      origin: "claude-code",
      content,
      filePath: absolutePath,
    },
  };
}

async function runStatus(strictDaemonStatus: boolean): Promise<never> {
  const port = await ensureDaemonPort();
  const result = await daemonStatus(daemonLaunchOptions(port));
  if (result.verdict !== "running") {
    console.log(`stopped ${getDaemonUrl(port)}`);
    process.exit(strictDaemonStatus ? EXIT_DENIED : EXIT_OK);
  }

  await waitForDaemonLiveness();
  const currentState = await readDaemonStateFromHttp();
  const summary =
    currentState.status === "idle"
      ? "idle"
      : `${currentState.status} ${summarizeDocument(currentState.document)}`;
  console.log(`running ${getDaemonUrl(port)} ${summary}`);
  process.exit(EXIT_OK);
}

async function verifyDaemonStarted(port: number, timeoutMs: number): Promise<boolean> {
  const lockfilePath = getDaemonLockfilePath();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(lockfilePath)) {
      return false;
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/state`, {
        signal: AbortSignal.timeout(500),
      });
      if (resp.ok) return true;
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return false;
}

async function runStart(): Promise<never> {
  const port = await ensureDaemonPort();
  const result = await startDaemonDetached(daemonLaunchOptions(port));
  if (result.verdict === "started") {
    const alive = await verifyDaemonStarted(port, 10_000);
    if (!alive) {
      fail("Daemon failed to start (port may be in use).", EXIT_DAEMON_FAILURE);
    }
  }
  const statusWord = result.verdict === "running" ? "running" : "started";
  console.log(`${statusWord} ${getDaemonUrl(port)} port=${port}`);
  process.exit(EXIT_OK);
}

async function runStop(): Promise<never> {
  const port = await ensureDaemonPort();
  const result = await stopDaemon(daemonLaunchOptions(port));
  const statusWord = result.verdict === "stopped" ? "stopped" : "stopped";
  console.log(`${statusWord} ${getDaemonUrl(port)}`);
  process.exit(EXIT_OK);
}

async function runOpen(): Promise<never> {
  await withDaemon(async () => {
    const session = await readActiveSession();
    const url = session?.url ?? getDaemonUrl();
    await openSessionUrl(url);
    console.log(url);
    process.exit(EXIT_OK);
  });

  fail("runOpen returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function resolveWaitRequestId(requestId?: string): Promise<string | undefined> {
  if (requestId) {
    return requestId;
  }

  const currentState = await readDaemonStateFromHttp().catch(() => null);
  if (currentState?.document?.id) {
    // Auto-bind when the daemon has an active or buffered request.
    // This covers both awaiting-response (in_review) and resolved (verdict_ready)
    // states, so `plannotator wait` recovers a buffered verdict without
    // requiring the user to discover and pass --request-id manually.
    if (currentState.status === "awaiting-response" || currentState.status === "awaiting-revision") {
      return currentState.document.id;
    }
  }

  return undefined;
}

async function runWait(args: string[]): Promise<never> {
  const json = takeFlag(args, "--json");
  const requestId = takeOption(args, "--request-id");

  await withDaemon(async () => {
    const boundRequestId = await resolveWaitRequestId(requestId);
    const verdict = await waitForVerdict(boundRequestId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(message, EXIT_DAEMON_FAILURE);
    });
    if (json) {
      renderJsonVerdict(verdict);
    }

    renderPlainVerdict(verdict);
  });

  fail("runWait returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function runClear(args: string[]): Promise<never> {
  const force = takeFlag(args, "--force");

  await withDaemon(async () => {
    const currentState = await readDaemonStateFromHttp();
    if (currentState.status === "idle") {
      console.log("Nothing to clear.");
      process.exit(EXIT_OK);
    }

    const { response, text } = await requestJson("/api/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
    });

    if (response.status === 409) {
      fail(text || "Daemon refused to clear state.", EXIT_ILLEGAL_STATE);
    }
    if (!response.ok) {
      fail(text || `Daemon clear failed with ${response.status}.`, EXIT_DAEMON_FAILURE);
    }

    console.log(`${force ? "cleared" : "discarded"} ${getDaemonUrl()}`);
    process.exit(EXIT_OK);
  });

  fail("runClear returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function runReview(args: string[]): Promise<never> {
  const json = takeFlag(args, "--json");
  const diffType = (takeOption(args, "--diff-type") as DiffType | undefined) ?? "uncommitted";
  const reviewCwd = process.env.PLANNOTATOR_CWD || process.cwd();
  const gitContext = await getGitContext(reviewCwd);
  const defaultBranch = gitContext.defaultBranch || (await getDefaultBranch(reviewCwd));
  const { patch, label } = await runGitDiff(diffType, defaultBranch, reviewCwd);
  const document: DocumentSnapshot = {
    id: `review-${crypto.randomUUID()}`,
    mode: "review",
    origin: "claude-code",
    content: patch,
    gitRef: label,
  };

  await submitDocument(document, {
    verdictFormat: json ? "json" : "plain",
    submitPayload: {
      diffType,
      cwd: reviewCwd,
    },
  });
  fail("runReview returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function runAnnotate(args: string[]): Promise<never> {
  const json = takeFlag(args, "--json");
  let filePath = args[0];
  if (!filePath) {
    fail("Usage: plannotator annotate <file.md>", EXIT_ILLEGAL_STATE);
  }

  if (filePath.startsWith("@")) {
    filePath = filePath.slice(1);
  }

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();
  const resolved = await resolveMarkdownFile(filePath, projectRoot);
  if (resolved.kind === "ambiguous") {
    fail(
      `Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:\n${resolved.matches.map((match) => `  ${match}`).join("\n")}`,
      EXIT_ILLEGAL_STATE,
    );
  }
  if (resolved.kind === "not_found") {
    fail(`File not found: ${resolved.input}`, EXIT_ILLEGAL_STATE);
  }

  const absolutePath = resolved.path;
  const markdown = await Bun.file(absolutePath).text();
  await submitDocument({
    id: `annotate-${crypto.randomUUID()}`,
    mode: "annotate",
    origin: "claude-code",
    content: markdown,
    filePath: absolutePath,
  }, {
    verdictFormat: json ? "json" : "plain",
  });
  fail("runAnnotate returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function runSubmit(args: string[]): Promise<never> {
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    console.log(
      [
        "plannotator submit <file> [options]",
        "",
        "Options:",
        "  --mode <plan|annotate>     Submission mode (default: plan)",
        "  --no-browser               Do not open a browser window",
        "  --commit-message <msg>     Attach a commit message to the submission",
        "  --json                     Output verdict as JSON on stdout",
        "  --request-id <id>          Request ID to associate with this submission",
        "  --help, -h                 Show this help",
      ].join("\n"),
    );
    process.exit(EXIT_OK);
  }
  const json = takeFlag(args, "--json");
  const mode = takeOption(args, "--mode") ?? "plan";
  const noBrowser = takeFlag(args, "--no-browser");
  const commitMessage = takeOption(args, "--commit-message");
  const fileArg = args[0];

  if (mode === "annotate") {
    if (!fileArg) {
      fail("submit --mode annotate requires <file>.", EXIT_ILLEGAL_STATE);
    }

    await runAnnotate([fileArg]);
    fail("annotate submit returned unexpectedly.", EXIT_DAEMON_FAILURE);
  }

  if (mode !== "plan") {
    fail(`Unsupported submit mode ${JSON.stringify(mode)}.`, EXIT_ILLEGAL_STATE);
  }

  const source = await resolvePlanSubmitSource(fileArg);
  await submitDocument(source.document, {
    noBrowser,
    permissionMode: source.permissionMode,
    commitMessage: commitMessage ?? source.commitMessage,
    verdictFormat: json ? "json" : "plain",
  });
  fail("runSubmit returned unexpectedly.", EXIT_DAEMON_FAILURE);
}

async function startForegroundDaemon(): Promise<void> {
  const project = (await detectProjectName()) ?? "_unknown";
  const repoInfo = await getRepoInfo();
  let currentState = loadState();
  let activeDraftKey: string | null = currentState.document ? contentHash(currentState.document.content) : null;
  let activePlanContext: ActivePlanContext | null = null;
  let activeReviewContext: ActiveReviewContext | null = null;
  let activeAnnotateContext: ActiveAnnotateContext | null = null;
  let activeSessionStartedAt = new Date().toISOString();

  const syncSession = () => {
    if (currentState.status === "idle" || !currentState.document) {
      unregisterSession(process.pid);
      return;
    }

    registerSession({
      pid: process.pid,
      port: getDaemonPort(),
      url: getDaemonUrl(),
      mode: currentState.document.mode,
      project,
      startedAt: activeSessionStartedAt,
      label: `${currentState.document.mode}-${documentTitle(currentState.document)}`,
    });
  };

  const setState = (nextState: DaemonState) => {
    currentState = nextState;
    saveState(nextState);

    if (nextState.status === "idle") {
      activeDraftKey = null;
      activePlanContext = null;
      activeReviewContext = null;
      activeAnnotateContext = null;
    }

    syncSession();
  };

  if (currentState.status !== "idle") {
    syncSession();
  }

  const eventBus = createDaemonEventBus();

  const router = createDaemonRouter(
    {
      getState: () => currentState,
      setState,
      planHtml: planHtmlContent,
      reviewHtml: reviewHtmlContent,
      getPlanResponse: () => ({
        permissionMode: activePlanContext?.permissionMode,
        previousPlan: activePlanContext?.previousPlan ?? null,
        versionInfo: activePlanContext?.versionInfo,
        repoInfo: activePlanContext?.repoInfo ?? repoInfo,
      }),
      getReviewResponse: () => ({
        origin: "claude-code",
        diffType: activeReviewContext?.diffType ?? "uncommitted",
        gitContext: activeReviewContext?.gitContext,
        repoInfo: activeReviewContext?.repoInfo ?? repoInfo,
        ...(activeReviewContext?.error ? { error: activeReviewContext.error } : {}),
      }),
      getAnnotateResponse: () => ({
        repoInfo: activeAnnotateContext?.repoInfo ?? repoInfo,
      }),
      async onSubmit({ body, nextState, uiUrl }) {
        activeSessionStartedAt = new Date().toISOString();
        activeDraftKey = nextState.document ? contentHash(nextState.document.content) : null;
        activePlanContext = null;
        activeReviewContext = null;
        activeAnnotateContext = null;

        if (nextState.document.mode === "plan") {
          const commitMessage =
            typeof body.commitMessage === "string" ? body.commitMessage : undefined;
          const slug = generateSlug(nextState.document.content);
          const historyResult = await saveToHistory(
            project,
            slug,
            nextState.document.content,
            commitMessage,
            nextState.document.origin,
          );
          const previousPlan =
            historyResult.version > 1
              ? await getPlanVersion(project, slug, historyResult.version - 1)
              : null;

          activePlanContext = {
            permissionMode:
              typeof body.permissionMode === "string" ? body.permissionMode : undefined,
            previousPlan,
            versionInfo: {
              version: historyResult.version,
              totalVersions: await getVersionCount(project, slug),
              project,
            },
            repoInfo,
          };
        } else if (nextState.document.mode === "review") {
          const reviewCwd =
            typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : undefined;
          const diffType =
            typeof body.diffType === "string" ? (body.diffType as DiffType) : "uncommitted";
          activeReviewContext = {
            diffType,
            cwd: reviewCwd,
            gitContext: await getGitContext(reviewCwd),
            repoInfo: (await getRepoInfo(reviewCwd)) ?? repoInfo,
          };
        } else {
          activeAnnotateContext = { repoInfo };
        }

        if (body.noBrowser !== true) {
          await openBrowser(uiUrl);
        }

        // Session registration must not wait on notification side effects.
        void notifyDocumentEnteredReview({
          documentTitle: documentTitle(nextState.document),
          daemonUrl: uiUrl,
        }).catch((error) => {
          console.error("notifyDocumentEnteredReview failed:", error);
        });

        return { opened: body.noBrowser !== true };
      },
      onApprove() {
        if (activeDraftKey) {
          handleDraftDelete(activeDraftKey);
        }
      },
      onDeny() {
        if (activeDraftKey) {
          handleDraftDelete(activeDraftKey);
        }
      },
      onFeedback() {
        if (activeDraftKey) {
          handleDraftDelete(activeDraftKey);
        }
      },
      onCancel() {
        if (activeDraftKey) {
          handleDraftDelete(activeDraftKey);
        }
      },
      onReset() {
        if (activeDraftKey) {
          handleDraftDelete(activeDraftKey);
        }
      },
      async handleFallback(req, url, state) {
        if (url.pathname === "/api/image") {
          return handleImage(req);
        }

        if (url.pathname === "/api/upload" && req.method === "POST") {
          return handleUpload(req);
        }

        if (url.pathname === "/api/draft") {
          if (!activeDraftKey) {
            return Response.json({ found: false }, { status: 404 });
          }
          if (req.method === "POST") return handleDraftSave(req, activeDraftKey);
          if (req.method === "DELETE") return handleDraftDelete(activeDraftKey);
          return handleDraftLoad(activeDraftKey);
        }

        if (url.pathname === "/api/doc" && req.method === "GET") {
          if (state.document?.filePath && !url.searchParams.has("base")) {
            const docUrl = new URL(req.url);
            docUrl.searchParams.set("base", dirname(state.document.filePath));
            return handleDoc(new Request(docUrl.toString()));
          }
          return handleDoc(req);
        }

        if (url.pathname === "/api/diff/switch" && req.method === "POST") {
          try {
            const body = (await req.json()) as { diffType?: DiffType };
            if (!body.diffType) {
              return Response.json({ error: "Missing diffType" }, { status: 400 });
            }

            const reviewCwd = activeReviewContext?.cwd;
            const defaultBranch =
              activeReviewContext?.gitContext.defaultBranch ??
              (await getDefaultBranch(reviewCwd));
            const result = await runGitDiff(body.diffType, defaultBranch, reviewCwd);
            if (currentState.document?.mode === "review" && currentState.document) {
              currentState = {
                ...currentState,
                document: {
                  ...currentState.document,
                  content: result.patch,
                  gitRef: result.label,
                },
              };
              saveState(currentState);
              activeReviewContext = {
                diffType: body.diffType,
                cwd: reviewCwd,
                gitContext: await getGitContext(reviewCwd),
                repoInfo: (await getRepoInfo(reviewCwd)) ?? repoInfo,
                error: result.error,
              };
            }

            return Response.json({
              rawPatch: result.patch,
              gitRef: result.label,
              diffType: body.diffType,
              ...(result.error ? { error: result.error } : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to switch diff";
            return Response.json({ error: message }, { status: 500 });
          }
        }

        if (url.pathname === "/api/file-content" && req.method === "GET") {
          const filePath = url.searchParams.get("path") ?? url.searchParams.get("file");
          if (!filePath) {
            return Response.json({ error: "Missing path" }, { status: 400 });
          }

          try {
            validateFilePath(filePath);
          } catch {
            return Response.json({ error: "Invalid path" }, { status: 400 });
          }

          const oldPath = url.searchParams.get("oldPath") || undefined;
          if (oldPath) {
            try {
              validateFilePath(oldPath);
            } catch {
              return Response.json({ error: "Invalid path" }, { status: 400 });
            }
          }

          try {
            const reviewCwd = activeReviewContext?.cwd;
            const diffType = activeReviewContext?.diffType ?? "uncommitted";
            const defaultBranch =
              activeReviewContext?.gitContext.defaultBranch ??
              (await getDefaultBranch(reviewCwd));
            return Response.json(
              await getFileContentsForDiff(
                diffType,
                defaultBranch,
                filePath,
                oldPath,
                reviewCwd,
              ),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Failed to get file content";
            return Response.json({ error: message }, { status: 500 });
          }
        }

        if (url.pathname === "/api/git-add" && req.method === "POST") {
          try {
            const body = (await req.json()) as { filePath?: string; undo?: boolean };
            if (!body.filePath) {
              return Response.json({ error: "Missing filePath" }, { status: 400 });
            }

            validateFilePath(body.filePath);
            const targetCwd = activeReviewContext?.cwd;
            if (body.undo) {
              await gitResetFile(body.filePath, targetCwd);
            } else {
              await gitAddFile(body.filePath, targetCwd);
            }

            return Response.json({ ok: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : "git add/reset failed";
            return Response.json({ error: message }, { status: 500 });
          }
        }

        return undefined;
      },
    },
    eventBus,
  );

  const server = Bun.serve({
    port: getDaemonPort(),
    fetch: router.fetch,
  });

  // Write discovery files only after the server has successfully bound its port.
  writeDaemonMetadata(getDaemonPort());
  writeFileSync(
    getDaemonLockfilePath(),
    JSON.stringify({
      pid: process.pid,
      childPid: process.pid,
      createdAt: new Date().toISOString(),
      command: process.argv,
      cwd: process.cwd(),
    }),
    "utf8",
  );

  const cleanup = () => {
    unregisterSession(process.pid);
    try { unlinkSync(getDaemonMetadataPath()); } catch {}
    try { unlinkSync(getDaemonLockfilePath()); } catch {}
    server.stop();
  };

  const handleSignal = (_signal: NodeJS.Signals) => {
    cleanup();
    process.exit(EXIT_OK);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

async function main(): Promise<void> {
  const args = parseCommand(process.argv.slice(2));

  if (args.length === 0) {
    await submitPlanFromHook();
    return;
  }

  if (args[0] === "daemon") {
    const subcommand = args[1];
    if (subcommand === "start") {
      if (args.includes("--foreground")) {
        await startForegroundDaemon();
        return;
      }
      await runStart();
      return;
    }
    if (subcommand === "stop") {
      await runStop();
      return;
    }
    if (subcommand === "status") {
      await runStatus(true);
      return;
    }

    fail(usageText(), EXIT_ILLEGAL_STATE);
  }

  switch (args[0]) {
    case "start":
      await runStart();
      return;
    case "stop":
      await runStop();
      return;
    case "status":
      await runStatus(true);
      return;
    case "submit":
      await runSubmit(args.slice(1));
      return;
    case "review":
      await runReview(args.slice(1));
      return;
    case "annotate":
      await runAnnotate(args.slice(1));
      return;
    case "wait":
      await runWait(args.slice(1));
      return;
    case "clear":
      await runClear(args.slice(1));
      return;
    case "open":
      await runOpen();
      return;
    default:
      fail(usageText(), EXIT_ILLEGAL_STATE);
  }
}

await main();
