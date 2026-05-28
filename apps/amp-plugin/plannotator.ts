import type { PluginAPI, PluginCommandContext, ThreadMessage } from "@ampcode/plugin";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const CATEGORY = "Plannotator";
const INSTALL_URL = "https://plannotator.ai/docs/getting-started/installation/";
const READY_TIMEOUT_MS = 30_000;
const MIN_READY_FILE_VERSION = "0.19.24";
const MIN_STDIN_LAST_VERSION = "0.19.24";
const RUNTIME = "amp";

const DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT =
  "# Markdown Annotations\n\n{{fileHeader}}: {{filePath}}\n\n{{feedback}}\n\nPlease address the annotation feedback above.";
const DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT =
  "# Message Annotations\n\n{{feedback}}\n\nPlease address the annotation feedback above.";

type CommandContext = PluginCommandContext;
type ReadyResult = "ready" | "exited" | "timeout";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface AnnotateDecision {
  decision: "approved" | "dismissed" | "annotated";
  feedback?: string;
}

interface ExitState {
  done: boolean;
}

interface PlannotatorRuntime {
  command: string[];
  source: "cli" | "source";
  version: string | null;
  features: {
    readyFile: boolean;
    stdinLast: boolean;
  };
}

let runtimePromise: Promise<PlannotatorRuntime> | null = null;

export default function plannotatorAmpPlugin(amp: PluginAPI) {
  amp.logger.log("[plannotator] Amp plugin initialized");

  amp.registerCommand(
    "plannotator-review",
    {
      title: "Review changes",
      category: CATEGORY,
      description: "Open Plannotator code review for the current workspace changes.",
    },
    async (ctx) => {
      const result = await runPlannotator(amp, ctx, ["review"]);
      await handleReviewResult(ctx, result);
    },
  );

  amp.registerCommand(
    "plannotator-review-target",
    {
      title: "Review changes or PR",
      category: CATEGORY,
      description: "Open Plannotator code review for local changes, a PR/MR URL, or review arguments.",
    },
    async (ctx) => {
      const target = await ctx.ui.input({
        title: "Review changes or PR",
        helpText: "Leave blank for local git changes, or enter a GitHub PR/GitLab MR URL or review arguments such as --git.",
        submitButtonText: "Review",
      });

      const reviewArgs = parseReviewTargetInput(target);
      if (!reviewArgs) return;

      const result = await runPlannotator(amp, ctx, ["review", ...reviewArgs]);
      await handleReviewResult(ctx, result);
    },
  );

  amp.registerCommand(
    "plannotator-annotate",
    {
      title: "Annotate file",
      category: CATEGORY,
      description: "Open Plannotator annotation UI for a markdown/html file, folder, or URL.",
    },
    async (ctx) => {
      const target = await ctx.ui.input({
        title: "Annotate",
        helpText: "Enter a markdown/html file, folder, or URL.",
        submitButtonText: "Annotate",
      });
      if (!target?.trim()) return;

      const args = splitCommandArgs(target);
      if (args.length === 0) return;
      const filePath = findFirstPositionalArg(args) ?? args[0];

      const result = await runPlannotator(amp, ctx, ["annotate", ...args, "--json"]);
      await handleAnnotateResult(ctx, result, { kind: "file", filePath });
    },
  );

  amp.registerCommand(
    "plannotator-last",
    {
      title: "Annotate last answer",
      category: CATEGORY,
      description: "Open Plannotator annotation UI for Amp's latest assistant message.",
    },
    async (ctx) => {
      if (!ctx.thread) {
        await ctx.ui.notify("No active Amp thread.");
        return;
      }

      const message = await getLatestAssistantText(ctx);
      if (!message) {
        await ctx.ui.notify("No assistant message found in this thread.");
        return;
      }

      const runtime = await getPlannotatorRuntime();
      let tempFile: string | null = null;
      let result: RunResult;

      try {
        if (runtime.features.stdinLast) {
          result = await runPlannotator(
            amp,
            ctx,
            ["annotate-last", "--stdin", "--json"],
            { stdin: message, runtime },
          );
        } else {
          tempFile = join(tmpdir(), `plannotator-amp-last-${process.pid}-${Date.now()}-${randomUUID()}.md`);
          writeFileSync(tempFile, message, "utf8");
          result = await runPlannotator(amp, ctx, ["annotate", tempFile, "--json"], { runtime });
        }
      } finally {
        if (tempFile) {
          try {
            unlinkSync(tempFile);
          } catch {
            // Best-effort cleanup for the fallback message file.
          }
        }
      }

      await handleAnnotateResult(ctx, result, { kind: "message" });
    },
  );
}

export function extractTextFromThreadMessage(message: ThreadMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text" && block.text.trim())
    .map((block) => block.text.trim())
    .join("\n\n")
    .trim();
}

export function parseAnnotateDecision(raw: string): AnnotateDecision | null {
  const trimmed = raw.trim();
  if (!trimmed) return { decision: "dismissed" };

  try {
    const parsed = JSON.parse(trimmed) as Partial<AnnotateDecision>;
    if (
      parsed &&
      (parsed.decision === "approved" ||
        parsed.decision === "dismissed" ||
        parsed.decision === "annotated")
    ) {
      return {
        decision: parsed.decision,
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function formatAnnotationFeedback(
  decision: AnnotateDecision,
  options: { kind: "file"; filePath: string } | { kind: "message" },
): string | null {
  if (decision.decision !== "annotated") return null;

  const feedback = decision.feedback?.trim();
  if (!feedback || isNoActionFeedback(feedback)) return null;

  const config = loadPlannotatorConfig();
  if (options.kind === "file") {
    const template = getConfiguredPrompt(config, "fileFeedback", DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT);
    return resolveTemplate(template, {
      fileHeader: "File",
      filePath: options.filePath,
      feedback,
    });
  }

  const template = getConfiguredPrompt(config, "messageFeedback", DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT);
  return resolveTemplate(template, { feedback });
}

export function isNoActionFeedback(output: string): boolean {
  const normalized = output.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "review session closed without feedback." ||
    normalized === "annotation session closed." ||
    normalized === "approved." ||
    normalized === "the user approved." ||
    normalized.includes("has no feedback")
  );
}

export function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const text = input.trim();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === "\\" && quote !== "'") {
      const next = text[i + 1];
      const escapesNext =
        next !== undefined &&
        (next === "\\" ||
          /\s/.test(next) ||
          next === quote ||
          (!quote && (next === "'" || next === '"')));

      if (escapesNext) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

export function findFirstPositionalArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return args[i + 1] ?? null;
    if (arg === "--browser") {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }

  return null;
}

export function parseReviewTargetInput(target: string | undefined): string[] | null {
  if (target === undefined) return null;
  return target.trim() ? splitCommandArgs(target) : [];
}

async function getLatestAssistantText(ctx: CommandContext): Promise<string | null> {
  if (!ctx.thread) return null;

  const latest = await ctx.thread.messages({ from: "end", limit: 1, roles: ["assistant"] });
  const latestText = latest.map(extractTextFromThreadMessage).find(Boolean);
  if (latestText) return latestText;

  const recent = await ctx.thread.messages({ from: "end", limit: 20, roles: ["assistant"] });
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const text = extractTextFromThreadMessage(recent[i]);
    if (text) return text;
  }

  return null;
}

async function handleReviewResult(ctx: CommandContext, result: RunResult): Promise<void> {
  if (await notifyFailure(ctx, result, "review")) return;

  const output = result.stdout.trim();
  if (isNoActionFeedback(output)) {
    await ctx.ui.notify(output || "Review session closed without feedback.");
    return;
  }

  await appendFeedback(ctx, output);
}

async function handleAnnotateResult(
  ctx: CommandContext,
  result: RunResult,
  options: { kind: "file"; filePath: string } | { kind: "message" },
): Promise<void> {
  if (await notifyFailure(ctx, result, "annotate")) return;

  const decision = parseAnnotateDecision(result.stdout);
  if (decision?.decision === "approved") {
    await ctx.ui.notify("Approved.");
    return;
  }
  if (decision?.decision === "dismissed") {
    await ctx.ui.notify("Annotation session closed.");
    return;
  }

  const feedback = decision
    ? formatAnnotationFeedback(decision, options)
    : result.stdout.trim();

  if (!feedback || isNoActionFeedback(feedback)) {
    await ctx.ui.notify("Annotation session closed without feedback.");
    return;
  }

  await appendFeedback(ctx, feedback);
}

async function appendFeedback(ctx: CommandContext, content: string): Promise<void> {
  if (!ctx.thread) {
    await ctx.ui.notify("Plannotator produced feedback, but there is no active Amp thread.");
    return;
  }

  await ctx.thread.append([{ type: "user-message", content }]);
}

async function notifyFailure(
  ctx: CommandContext,
  result: RunResult,
  mode: "review" | "annotate",
): Promise<boolean> {
  if (!result.error && result.status === 0) return false;

  const details = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n")
    .trim();
  const missingExecutable = /\bENOENT\b/i.test(details) ||
    /executable not found/i.test(details) ||
    /command not found/i.test(details);
  const installHint = missingExecutable
    ? `\n\nInstall the CLI first: ${INSTALL_URL}`
    : "";

  await ctx.ui.notify(`Plannotator ${mode} failed.${details ? `\n\n${details}` : ""}${installHint}`);
  return true;
}

async function runPlannotator(
  amp: PluginAPI,
  ctx: CommandContext,
  args: string[],
  options: { stdin?: string; runtime?: PlannotatorRuntime } = {},
): Promise<RunResult> {
  const cwd = await resolveCwd(ctx);
  const runtime = options.runtime ?? await getPlannotatorRuntime();
  const readyFile = runtime.features.readyFile
    ? join(tmpdir(), `plannotator-amp-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`)
    : null;
  const command = [...runtime.command, ...args];
  const env = buildEnv(buildPlannotatorEnv(cwd, readyFile));

  let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: options.stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (options.stdin && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const exitState: ExitState = { done: false };
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = collectStderr(amp, ctx, proc.stderr);
  const exitedPromise = proc.exited.finally(() => {
    exitState.done = true;
  });

  let readyPromise: Promise<ReadyResult> | null = null;
  if (readyFile) {
    readyPromise = waitForReadyFile(readyFile, exitState);
    const readyResult = await readyPromise;
    if (readyResult === "timeout") {
      try {
        proc.kill();
      } catch {
        // Process may already have exited.
      }
    }
  }

  const status = await exitedPromise;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  try {
    if (readyFile) unlinkSync(readyFile);
  } catch {
    // Temporary ready file may not exist if the command failed early.
  }

  const readyTimedOut = readyPromise ? (await readyPromise) === "timeout" : false;
  return {
    status,
    stdout,
    stderr,
    ...(readyTimedOut ? { error: "Timed out waiting for Plannotator to publish its browser URL." } : {}),
  };
}

export async function resolveCwd(ctx: CommandContext): Promise<string> {
  const explicitCwd = normalizeDirectory(process.env.PLANNOTATOR_CWD);
  if (explicitCwd) return explicitCwd;

  const ampWorkspaceRoot = resolveAmpWorkspaceRoot();
  if (ampWorkspaceRoot) return ampWorkspaceRoot;

  try {
    const result = await ctx.$`pwd`;
    const cwd = normalizeDirectory(result.stdout);
    if (cwd) return cwd;
  } catch {
    // Fall through to process-level cwd fallbacks.
  }

  const shellPwd = normalizeDirectory(process.env.PWD);
  if (shellPwd) return shellPwd;

  return normalizeDirectory(process.cwd()) ?? process.cwd();
}

export function resolveAmpWorkspaceRoot(
  options: { logPath?: string; parentPid?: number } = {},
): string | null {
  const logPath = options.logPath ?? process.env.AMP_LOG_FILE ?? join(getAmpCacheDir(), "logs", "cli.log");
  if (!existsSync(logPath)) return null;

  const parentPid = options.parentPid ?? process.ppid;
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  let latestWorkspace: string | null = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: { pid?: unknown; workspaceRoot?: unknown };
    try {
      entry = JSON.parse(lines[i]) as { pid?: unknown; workspaceRoot?: unknown };
    } catch {
      continue;
    }

    const workspace = normalizeWorkspaceRoot(entry.workspaceRoot);
    if (!workspace) continue;

    latestWorkspace ??= workspace;
    if (entry.pid === parentPid) return workspace;
  }

  return latestWorkspace;
}

function normalizeWorkspaceRoot(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const path = value.startsWith("file://") ? fileUrlToPath(value) : value;
    return normalizeDirectory(path);
  } catch {
    return null;
  }
}

function fileUrlToPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);

  const pathname = decodeURIComponent(url.pathname);
  return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)
    ? pathname.slice(1)
    : pathname;
}

export function buildPlannotatorEnv(cwd: string, readyFile: string | null): Record<string, string> {
  return {
    PLANNOTATOR_ORIGIN: RUNTIME,
    PLANNOTATOR_CWD: cwd,
    ...(readyFile ? { PLANNOTATOR_READY_FILE: readyFile } : {}),
  };
}

function normalizeDirectory(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate === "undefined" || candidate === "null") return null;

  try {
    return statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function buildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
}

async function collectStderr(
  amp: PluginAPI,
  ctx: CommandContext,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const seenUrls = new Set<string>();
  let output = "";
  let lineBuffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    output += text;
    lineBuffer += text;

    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      await notifyUrls(ctx, line, seenUrls);
    }
  }

  const tail = decoder.decode();
  output += tail;
  if (tail) lineBuffer += tail;
  if (lineBuffer) await notifyUrls(ctx, lineBuffer, seenUrls);

  if (output.trim()) amp.logger.log(output.trim());
  return output;
}

async function notifyUrls(
  ctx: CommandContext,
  text: string,
  seenUrls: Set<string>,
): Promise<void> {
  const matches = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  for (const rawUrl of matches) {
    const url = rawUrl.replace(/[.,;]+$/, "");
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    await ctx.ui.notify(`Plannotator link:\n${url}`);
  }
}

async function waitForReadyFile(
  readyFile: string,
  exitState: ExitState,
): Promise<ReadyResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      const lines = readFileSync(readyFile, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let payload: { url?: unknown };
        try {
          payload = JSON.parse(line) as { url?: unknown };
        } catch {
          // Keep polling; the writer may still be appending the line.
          continue;
        }

        if (typeof payload.url !== "string" || seen.has(payload.url)) continue;
        seen.add(payload.url);
        return "ready";
      }
    }

    if (exitState.done) return "exited";
    await sleep(100);
  }

  return "timeout";
}

async function getPlannotatorRuntime(): Promise<PlannotatorRuntime> {
  runtimePromise ??= resolvePlannotatorRuntime();
  return runtimePromise;
}

async function resolvePlannotatorRuntime(): Promise<PlannotatorRuntime> {
  const explicitSource = process.env.PLANNOTATOR_AMP_SOURCE_ENTRY;
  const sourceEntry = explicitSource
    ? resolve(explicitSource)
    : process.env.PLANNOTATOR_AMP_USE_SOURCE === "1"
      ? findSourceEntry(import.meta.dir)
      : null;

  if (sourceEntry && existsSync(sourceEntry)) {
    return {
      command: [getBunExecutable(), sourceEntry],
      source: "source",
      version: "source",
      features: { readyFile: true, stdinLast: true },
    };
  }

  const { command, version } = resolvePlannotatorCommand();
  return {
    command,
    source: "cli",
    version,
    features: {
      readyFile: semverGte(version, MIN_READY_FILE_VERSION),
      stdinLast: semverGte(version, MIN_STDIN_LAST_VERSION),
    },
  };
}

function resolvePlannotatorCommand(): { command: string[]; version: string | null } {
  const candidates = getPlannotatorCommandCandidates();
  let fallback = candidates[candidates.length - 1] ?? ["plannotator"];

  for (const command of candidates) {
    const executable = command[0];
    if (!executable) continue;

    if (isPathLike(executable)) {
      if (!existsSync(executable)) continue;
      const version = detectPlannotatorVersion(command);
      return { command, version };
    }

    fallback = command;
    const version = detectPlannotatorVersion(command);
    if (version) return { command, version };
  }

  return { command: fallback, version: detectPlannotatorVersion(fallback) };
}

export function getPlannotatorCommandCandidates(
  options: {
    env?: Record<string, string | undefined>;
    home?: string;
    pluginDir?: string;
    platform?: string;
  } = {},
): string[][] {
  const env = options.env ?? process.env;
  const homes = getHomeDirectoryCandidates(env, options.home, options.pluginDir ?? import.meta.dir);
  const platform = options.platform ?? process.platform;
  const candidates: string[][] = [];

  const explicitBin = normalizeExecutablePath(env.PLANNOTATOR_BIN);
  if (explicitBin) candidates.push([explicitBin]);

  if (platform === "win32") {
    const localAppData = normalizeExecutablePath(env.LOCALAPPDATA);
    if (localAppData) candidates.push([join(localAppData, "plannotator", "plannotator.exe")]);

    for (const home of homes) {
      candidates.push([join(home, ".local", "bin", "plannotator.exe")]);
    }
  } else {
    for (const home of homes) {
      candidates.push([join(home, ".local", "bin", "plannotator")]);
    }
  }

  candidates.push(["plannotator"]);
  return dedupeCommands(candidates);
}

function normalizeExecutablePath(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate === "undefined" || candidate === "null") return null;
  return candidate;
}

function getHomeDirectoryCandidates(
  env: Record<string, string | undefined>,
  explicitHome: string | undefined,
  pluginDir: string,
): string[] {
  return dedupeStrings([
    normalizeExecutablePath(explicitHome),
    normalizeExecutablePath(env.HOME),
    normalizeExecutablePath(env.USERPROFILE),
    deriveHomeFromAmpPluginDir(pluginDir),
    explicitHome === undefined ? normalizeExecutablePath(homedir()) : null,
  ]);
}

function deriveHomeFromAmpPluginDir(pluginDir: string): string | null {
  const pluginsDir = resolve(pluginDir);
  const ampDir = dirname(pluginsDir);
  const configDir = dirname(ampDir);

  if (
    basename(pluginsDir) === "plugins" &&
    basename(ampDir) === "amp" &&
    basename(configDir) === ".config"
  ) {
    return dirname(configDir);
  }

  return null;
}

function getAmpCacheDir(): string {
  const cacheHome = normalizeExecutablePath(process.env.XDG_CACHE_HOME);
  return cacheHome ? join(cacheHome, "amp") : join(homedir(), ".cache", "amp");
}

function dedupeCommands(commands: string[][]): string[][] {
  const seen = new Set<string>();
  const deduped: string[][] = [];
  for (const command of commands) {
    const key = command.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(command);
  }
  return deduped;
}

function dedupeStrings(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function findSourceEntry(startDir: string): string | null {
  const root = findRepoRoot(startDir);
  if (!root) return null;

  const sourceEntry = join(root, "apps", "hook", "server", "index.ts");
  return existsSync(sourceEntry) ? sourceEntry : null;
}

function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);

  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (pkg.name === "plannotator") return dir;
      } catch {
        // Ignore malformed package.json while walking upward.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function getBunExecutable(): string {
  const candidates = [process.execPath, Bun.argv[0], Bun.which?.("bun"), "bun"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || value === "undefined" || value === "null") continue;
    return value;
  }

  return "bun";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function detectPlannotatorVersion(command: string[]): string | null {
  try {
    const result = Bun.spawnSync([...command, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;

    const output = new TextDecoder().decode(result.stdout).trim();
    const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function semverGte(actual: string | null, minimum: string): boolean {
  if (!actual) return false;
  const actualParts = actual.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));

  for (let i = 0; i < 3; i += 1) {
    const actualPart = actualParts[i] ?? 0;
    const minimumPart = minimumParts[i] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }

  return true;
}

type PromptConfig = {
  prompts?: {
    annotate?: {
      fileFeedback?: unknown;
      messageFeedback?: unknown;
      runtimes?: Partial<Record<typeof RUNTIME, {
        fileFeedback?: unknown;
        messageFeedback?: unknown;
      }>>;
    };
  };
};

function loadPlannotatorConfig(): PromptConfig {
  try {
    const configPath = join(getPlannotatorDataDir(), "config.json");
    if (!existsSync(configPath)) return {};

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as PromptConfig : {};
  } catch {
    return {};
  }
}

export function getPlannotatorDataDir(): string {
  const value = process.env.PLANNOTATOR_DATA_DIR?.trim();
  if (!value) return join(homedir(), ".plannotator");

  const home = homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(home, value.slice(2));
  }

  return resolve(value);
}

function getConfiguredPrompt(
  config: PromptConfig,
  key: "fileFeedback" | "messageFeedback",
  fallback: string,
): string {
  const annotate = config.prompts?.annotate;
  const runtimePrompt = normalizePrompt(annotate?.runtimes?.[RUNTIME]?.[key]);
  const genericPrompt = normalizePrompt(annotate?.[key]);
  return runtimePrompt ?? genericPrompt ?? fallback;
}

function normalizePrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  return prompt.trim() ? prompt : undefined;
}

function resolveTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = vars[key];
    return value !== undefined ? value : match;
  });
}
