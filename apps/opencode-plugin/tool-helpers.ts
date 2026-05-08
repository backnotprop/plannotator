import type { ToolContext } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { join } from "node:path";

export const REVIEW_TOOL_DIFF_TYPES = [
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
] as const;

export type ReviewToolDiffType = typeof REVIEW_TOOL_DIFF_TYPES[number];

type SessionPromptClient = {
  session: {
    prompt(input: {
      path: { id: string };
      body: {
        agent?: string;
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<unknown>;
  };
};

export type PlannotatorCliVerdict = {
  approved: boolean;
  cancelled?: boolean;
  feedback?: string;
  mode: "plan" | "review" | "annotate";
  agentSwitch?: string;
  permissionMode?: string;
};

export interface PlannotatorToolEnvironment {
  client: SessionPromptClient;
  directory: string;
}

type CliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type CliCommand = {
  argv: string[];
};

class CliTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliTimeoutError";
  }
}

/** Resolves the plannotator CLI command. Supports PLANNOTATOR_CLI_ENTRYPOINT env override for testing. */
function resolvePlannotatorCommand(directory: string): CliCommand {
  const envOverride: string | undefined = process.env.PLANNOTATOR_CLI_ENTRYPOINT;
  if (envOverride !== undefined) {
    return { argv: [process.execPath, "run", envOverride] };
  }

  const installedBinary = Bun.which("plannotator");
  if (installedBinary !== null) {
    return { argv: [installedBinary] };
  }

  const entrypoint = join(directory, "apps", "hook", "server", "index.ts");
  return { argv: [process.execPath, "run", entrypoint] };
}

async function runPlannotatorCli(
  args: string[],
  directory: string,
  options: {
    stdinText?: string;
    timeoutMs?: number | null;
  } = {},
): Promise<CliResult> {
  const command = resolvePlannotatorCommand(directory);
  const child = spawn(command.argv[0], [...command.argv.slice(1), ...args], {
    cwd: directory,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: directory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (options.stdinText !== undefined) {
    child.stdin.write(options.stdinText);
  }
  child.stdin.end();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const exitCode =
      options.timeoutMs == null
        ? await new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => {
              resolve(code ?? 1);
            });
          })
        : await Promise.race<number>([
            new Promise<number>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) => {
                resolve(code ?? 1);
              });
            }),
            new Promise<number>((_, reject) => {
              timeoutId = setTimeout(() => {
                try {
                  child.kill("SIGTERM");
                } catch {
                  // The subprocess may have already exited.
                }
                reject(
                  new CliTimeoutError(
                    `Timed out waiting for plannotator ${args[0]} after ${options.timeoutMs}ms.`,
                  ),
                );
              }, options.timeoutMs);
            }),
          ]);

    return { exitCode, stdout, stderr };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function parseCliVerdict(stdout: string): PlannotatorCliVerdict {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Plannotator CLI returned an empty verdict payload.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse plannotator CLI verdict JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plannotator CLI verdict payload must be a JSON object.");
  }

  const verdict = parsed as Record<string, unknown>;
  const mode = verdict.mode;
  if (mode !== "plan" && mode !== "review" && mode !== "annotate") {
    throw new Error("Plannotator CLI verdict payload is missing a valid mode.");
  }

  if (typeof verdict.approved !== "boolean") {
    throw new Error("Plannotator CLI verdict payload is missing boolean `approved`.");
  }

  const feedback =
    verdict.feedback === undefined
      ? undefined
      : typeof verdict.feedback === "string"
        ? verdict.feedback
        : (() => {
            throw new Error("Plannotator CLI verdict `feedback` must be a string when present.");
          })();

  const cancelled =
    verdict.cancelled === undefined
      ? undefined
      : typeof verdict.cancelled === "boolean"
        ? verdict.cancelled
        : (() => {
            throw new Error("Plannotator CLI verdict `cancelled` must be a boolean when present.");
          })();

  const agentSwitch =
    verdict.agentSwitch === undefined
      ? undefined
      : typeof verdict.agentSwitch === "string"
        ? verdict.agentSwitch
        : (() => {
            throw new Error("Plannotator CLI verdict `agentSwitch` must be a string when present.");
          })();

  const permissionMode =
    verdict.permissionMode === undefined
      ? undefined
      : typeof verdict.permissionMode === "string"
        ? verdict.permissionMode
        : (() => {
            throw new Error(
              "Plannotator CLI verdict `permissionMode` must be a string when present.",
            );
          })();

  return {
    approved: verdict.approved,
    cancelled,
    feedback,
    mode,
    agentSwitch,
    permissionMode,
  };
}

function describeCliFailure(args: string[], result: CliResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [
    `plannotator ${args.join(" ")} failed with exit code ${result.exitCode}.`,
    stderr ? `stderr:\n${stderr}` : null,
    stdout ? `stdout:\n${stdout}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

function buildReviewFeedbackMessage(
  approved: boolean,
  feedback: string,
): string {
  if (approved) {
    return `# Code Review\n\nCode review completed with notes:\n\n${feedback}`;
  }

  return `# Code Review Feedback\n\n${feedback}\n\nPlease address this feedback.`;
}

function buildAnnotateFeedbackMessage(
  filePath: string,
  feedback: string,
): string {
  return `# Markdown Annotations\n\nFile: ${filePath}\n\n${feedback}\n\nPlease address the annotation feedback above.`;
}

async function maybePromptSession(
  client: SessionPromptClient,
  sessionID: string,
  message: string,
  agent?: string,
): Promise<void> {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: message }],
    },
  });
}

export async function runPlannotatorSubmitCli(
  args: {
    plan: string;
    commit_message: string;
  },
  env: PlannotatorToolEnvironment,
  timeoutMs: number | null,
): Promise<PlannotatorCliVerdict> {
  const stdinText = JSON.stringify({
    tool_input: {
      plan: args.plan,
      commit_message: args.commit_message,
    },
  });

  const result = await runPlannotatorCli(["submit", "--json"], env.directory, {
    stdinText,
    timeoutMs,
  });

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(describeCliFailure(["submit", "--json"], result));
  }

  return parseCliVerdict(result.stdout);
}

export async function runPlannotatorReviewTool(
  args: { diff_type?: ReviewToolDiffType },
  context: ToolContext,
  env: PlannotatorToolEnvironment,
  options: { promptSessionOnCompletion?: boolean } = {},
): Promise<string> {
  const diffType = args.diff_type ?? "uncommitted";
  const cliArgs = ["review", "--json", "--diff-type", diffType];
  const result = await runPlannotatorCli(cliArgs, env.directory);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(describeCliFailure(cliArgs, result));
  }

  const verdict = parseCliVerdict(result.stdout);

  if (verdict.cancelled) {
    if (options.promptSessionOnCompletion) {
      await maybePromptSession(env.client, context.sessionID, "Code review cancelled by user.");
    }
    return "Code review cancelled by user.";
  }

  if (verdict.feedback) {
    const targetAgent =
      verdict.agentSwitch && verdict.agentSwitch !== "disabled"
        ? verdict.agentSwitch
        : undefined;
    const message = buildReviewFeedbackMessage(verdict.approved, verdict.feedback);
    if (options.promptSessionOnCompletion) {
      await maybePromptSession(env.client, context.sessionID, message, targetAgent);
    }

    return verdict.approved
      ? `Code review completed with notes.\n\n${verdict.feedback}`
      : `Code review feedback received.\n\n${verdict.feedback}`;
  }

  return "Code review completed with no requested changes.";
}

export async function runPlannotatorAnnotateTool(
  args: { file_path: string },
  context: ToolContext,
  env: PlannotatorToolEnvironment,
  options: { promptSessionOnCompletion?: boolean } = {},
): Promise<string> {
  const cliArgs = ["annotate", "--json", args.file_path];
  const result = await runPlannotatorCli(cliArgs, env.directory);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(describeCliFailure(cliArgs, result));
  }

  const verdict = parseCliVerdict(result.stdout);

  if (verdict.cancelled) {
    const message = `Annotation of ${args.file_path} cancelled by user.`;
    if (options.promptSessionOnCompletion) {
      await maybePromptSession(env.client, context.sessionID, message);
    }
    return message;
  }

  if (verdict.feedback) {
    const message = buildAnnotateFeedbackMessage(args.file_path, verdict.feedback);
    if (options.promptSessionOnCompletion) {
      await maybePromptSession(env.client, context.sessionID, message);
    }
    return `Annotation feedback received for ${args.file_path}.\n\n${verdict.feedback}`;
  }

  return `Annotation completed for ${args.file_path} with no requested changes.`;
}

export { CliTimeoutError };
