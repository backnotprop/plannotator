import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseAnnotateArgs, type ParsedAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
} from "@plannotator/shared/prompts";

type LogLevel = "info" | "error";

interface OpenCodeClient {
  app?: {
    log?: (entry: { level: LogLevel; message: string }) => unknown;
  };
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
}

export interface OpenCodeBridgeAgent {
  name: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
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

interface CliAnnotateOutcome {
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
  if (/^https?:\/\/\S+/.test(trimmed)) return trimmed;
  if (/^\(.+annotations added in browser\)$/.test(trimmed)) return trimmed;
  return undefined;
}

function createCliStderrForwarder(client: OpenCodeClient) {
  let pending = "";
  const forwarded = new Set<string>();

  const forwardLine = (line: string) => {
    const message = formatUserFacingCliStderrLine(line);
    if (!message || forwarded.has(message)) return;
    forwarded.add(message);
    log(client, "info", `[Plannotator] ${message}`);
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

function logReadyFile(client: OpenCodeClient, readyFile: string, readyLabel: string, loggedUrls: Set<string>): void {
  if (!existsSync(readyFile)) return;

  const contents = readFileSync(readyFile, "utf-8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const metadata = JSON.parse(line) as { url?: string };
      if (!metadata.url || loggedUrls.has(metadata.url)) continue;
      loggedUrls.add(metadata.url);
      log(client, "info", `[Plannotator] Open ${readyLabel}: ${metadata.url}`);
    } catch {
      // Ignore partial lines while the child process is writing.
    }
  }
}

async function runPlannotatorCli(options: RunCliOptions): Promise<RunCliResult> {
  const readyFile = path.join(
    tmpdir(),
    `plannotator-opencode-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`,
  );
  const loggedUrls = new Set<string>();
  const cwd = options.cwd || process.cwd();
  const env = {
    ...process.env,
    ...options.extraEnv,
    ...buildCliBridgeEnv(options.bridge),
    OPENCODE: "1",
    PLANNOTATOR_ORIGIN: "opencode",
    PLANNOTATOR_CWD: cwd,
    PLANNOTATOR_READY_FILE: readyFile,
  };

  const bin = getPlannotatorBin();
  const spawnConfig = buildCliSpawnConfig(bin, options.args);
  log(options.client, "info", `[Plannotator] Starting ${options.readyLabel}...`);

  return await new Promise((resolve, reject) => {
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd,
      env,
      shell: spawnConfig.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stderrForwarder = createCliStderrForwarder(options.client);
    const interval = setInterval(
      () => logReadyFile(options.client, readyFile, options.readyLabel, loggedUrls),
      250,
    );

    if (!child.stdin || !child.stdout || !child.stderr) {
      clearInterval(interval);
      rmSync(readyFile, { force: true });
      reject(new Error("Failed to open pipes for the plannotator CLI process."));
      return;
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      stderrForwarder.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearInterval(interval);
      stderrForwarder.flush();
      logReadyFile(options.client, readyFile, options.readyLabel, loggedUrls);
      rmSync(readyFile, { force: true });
      if (error.code === "ENOENT") {
        reject(new Error("Could not find the plannotator CLI. Install it with: curl -fsSL https://plannotator.ai/install.sh | bash"));
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearInterval(interval);
      stderrForwarder.flush();
      logReadyFile(options.client, readyFile, options.readyLabel, loggedUrls);
      rmSync(readyFile, { force: true });
      resolve({ stdout, stderr, exitCode });
    });

    child.stdin.end(options.input ?? "");
  });
}

export function buildAnnotateCliArgs(parsed: ParsedAnnotateArgs): string[] {
  const args = ["annotate", parsed.rawFilePath, "--json"];
  if (parsed.gate) args.push("--gate");
  if (parsed.renderHtml) args.push("--render-html");
  if (parsed.noJina) args.push("--no-jina");
  return args;
}

export async function runCliPlanReview(input: {
  client: OpenCodeClient;
  planContent: string;
  cwd?: string;
  timeoutSeconds: number | null;
  bridge?: OpenCodeBridgeContext;
}): Promise<OpenCodePlanReviewResult> {
  const result = await runPlannotatorCli({
    client: input.client,
    args: ["opencode-plan"],
    cwd: input.cwd,
    input: JSON.stringify({
      plan: input.planContent,
      timeoutSeconds: input.timeoutSeconds,
      ...buildBridgePayload(input.bridge),
    }),
    readyLabel: "plan review",
    bridge: input.bridge,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
  }

  logCliWarnings(input.client, result.stderr);
  return parseLastJson<OpenCodePlanReviewResult>(result.stdout);
}

async function injectSessionPrompt(
  client: OpenCodeClient,
  sessionId: string | undefined,
  text: string,
  options?: { agent?: string; noReply?: boolean },
): Promise<void> {
  if (!sessionId || !text.trim()) return;
  try {
    await client.session?.prompt?.({
      path: { id: sessionId },
      body: {
        ...(options?.agent && { agent: options.agent }),
        ...(options?.noReply && { noReply: true }),
        parts: [{ type: "text", text }],
      },
    });
  } catch {
    // Session may be unavailable or busy.
  }
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
    recentMessages.push({
      messageId: msg.info?.id ?? `opencode-${i}`,
      text: textParts.join("\n"),
      timestamp: msg.info?.time?.created ? new Date(msg.info.time.created).toISOString() : undefined,
    });
  }

  return recentMessages;
}

export function buildReviewPromptFromBridgeOutcome(outcome: CliReviewOutcome): {
  message: string | null;
  agent?: string;
} {
  if (outcome.decision === "dismissed") return { message: null };

  const shouldSwitchAgent = outcome.agentSwitch && outcome.agentSwitch !== "disabled";
  const targetAgent = shouldSwitchAgent ? outcome.agentSwitch : undefined;

  if (outcome.approved || outcome.decision === "approved") {
    return {
      message: getReviewApprovedPrompt("opencode"),
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

export async function handleCliCommand(input: {
  command: string;
  client: OpenCodeClient;
  sessionId?: string;
  rawArgs: string;
  cwd?: string;
  bridge?: OpenCodeBridgeContext;
}): Promise<void> {
  try {
    if (input.command === "plannotator-review") {
      const result = await runPlannotatorCli({
        client: input.client,
        args: ["opencode-review"],
        cwd: input.cwd,
        input: JSON.stringify({
          arguments: input.rawArgs,
          ...buildBridgePayload(input.bridge),
        }),
        readyLabel: "code review",
        bridge: input.bridge,
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliReviewOutcome>(result.stdout);
      const prompt = buildReviewPromptFromBridgeOutcome(outcome);
      if (prompt.message) {
        await injectSessionPrompt(input.client, input.sessionId, prompt.message, {
          agent: prompt.agent,
        });
      }
      return;
    }

    if (input.command === "plannotator-annotate") {
      const parsed = parseAnnotateArgs(input.rawArgs);
      if (!parsed.filePath) {
        log(input.client, "error", "Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--no-jina] [--gate] [--json]");
        return;
      }

      const result = await runPlannotatorCli({
        client: input.client,
        args: buildAnnotateCliArgs(parsed),
        cwd: input.cwd,
        readyLabel: "annotation UI",
        bridge: input.bridge,
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliAnnotateOutcome>(result.stdout);
      if (outcome.decision === "annotated" && outcome.feedback) {
        await injectSessionPrompt(
          input.client,
          input.sessionId,
          getAnnotateFileFeedbackPrompt("opencode", undefined, {
            fileHeader: getAnnotateFileHeader(parsed.filePath, input.cwd),
            filePath: parsed.filePath,
            feedback: outcome.feedback,
          }),
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
        cwd: input.cwd,
        input: JSON.stringify({
          gate: parsed.gate,
          recentMessages,
          ...buildBridgePayload(input.bridge),
        }),
        readyLabel: "annotation UI",
        bridge: input.bridge,
      });
      if (result.exitCode !== 0) {
        log(input.client, "error", result.stderr.trim() || `Plannotator CLI exited with code ${result.exitCode}`);
        return;
      }

      logCliWarnings(input.client, result.stderr);
      const outcome = parseLastJson<CliAnnotateOutcome>(result.stdout);
      if (outcome.decision === "annotated" && outcome.feedback) {
        await injectSessionPrompt(
          input.client,
          input.sessionId,
          getAnnotateMessageFeedbackPrompt("opencode", undefined, { feedback: outcome.feedback }),
        );
      }
      return;
    }

  } catch (error) {
    log(input.client, "error", `[Plannotator] ${error instanceof Error ? error.message : String(error)}`);
  }
}
