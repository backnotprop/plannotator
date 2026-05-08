// @bun
// index.ts
import { tool } from "@opencode-ai/plugin";

// tool-helpers.ts
import { spawn } from "child_process";
import { join } from "path";
var REVIEW_TOOL_DIFF_TYPES = [
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch"
];

class CliTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliTimeoutError";
  }
}
function resolvePlannotatorCommand(directory) {
  const envOverride = process.env.PLANNOTATOR_CLI_ENTRYPOINT;
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
async function runPlannotatorCli(args, directory, options = {}) {
  const command = resolvePlannotatorCommand(directory);
  const child = spawn(command.argv[0], [...command.argv.slice(1), ...args], {
    cwd: directory,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: directory
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (options.stdinText !== undefined) {
    child.stdin.write(options.stdinText);
  }
  child.stdin.end();
  let timeoutId;
  try {
    const exitCode = options.timeoutMs == null ? await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve(code ?? 1);
      });
    }) : await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          resolve(code ?? 1);
        });
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
          reject(new CliTimeoutError(`Timed out waiting for plannotator ${args[0]} after ${options.timeoutMs}ms.`));
        }, options.timeoutMs);
      })
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
function parseCliVerdict(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Plannotator CLI returned an empty verdict payload.");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse plannotator CLI verdict JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plannotator CLI verdict payload must be a JSON object.");
  }
  const verdict = parsed;
  const mode = verdict.mode;
  if (mode !== "plan" && mode !== "review" && mode !== "annotate") {
    throw new Error("Plannotator CLI verdict payload is missing a valid mode.");
  }
  if (typeof verdict.approved !== "boolean") {
    throw new Error("Plannotator CLI verdict payload is missing boolean `approved`.");
  }
  const feedback = verdict.feedback === undefined ? undefined : typeof verdict.feedback === "string" ? verdict.feedback : (() => {
    throw new Error("Plannotator CLI verdict `feedback` must be a string when present.");
  })();
  const cancelled = verdict.cancelled === undefined ? undefined : typeof verdict.cancelled === "boolean" ? verdict.cancelled : (() => {
    throw new Error("Plannotator CLI verdict `cancelled` must be a boolean when present.");
  })();
  const agentSwitch = verdict.agentSwitch === undefined ? undefined : typeof verdict.agentSwitch === "string" ? verdict.agentSwitch : (() => {
    throw new Error("Plannotator CLI verdict `agentSwitch` must be a string when present.");
  })();
  const permissionMode = verdict.permissionMode === undefined ? undefined : typeof verdict.permissionMode === "string" ? verdict.permissionMode : (() => {
    throw new Error("Plannotator CLI verdict `permissionMode` must be a string when present.");
  })();
  return {
    approved: verdict.approved,
    cancelled,
    feedback,
    mode,
    agentSwitch,
    permissionMode
  };
}
function describeCliFailure(args, result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [
    `plannotator ${args.join(" ")} failed with exit code ${result.exitCode}.`,
    stderr ? `stderr:
${stderr}` : null,
    stdout ? `stdout:
${stdout}` : null
  ].filter((part) => part !== null).join(`

`);
}
function buildReviewFeedbackMessage(approved, feedback) {
  if (approved) {
    return `# Code Review

Code review completed with notes:

${feedback}`;
  }
  return `# Code Review Feedback

${feedback}

Please address this feedback.`;
}
function buildAnnotateFeedbackMessage(filePath, feedback) {
  return `# Markdown Annotations

File: ${filePath}

${feedback}

Please address the annotation feedback above.`;
}
async function maybePromptSession(client, sessionID, message, agent) {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      ...agent ? { agent } : {},
      parts: [{ type: "text", text: message }]
    }
  });
}
async function runPlannotatorSubmitCli(args, env, timeoutMs) {
  const stdinText = JSON.stringify({
    tool_input: {
      plan: args.plan,
      commit_message: args.commit_message
    }
  });
  const result = await runPlannotatorCli(["submit", "--json"], env.directory, {
    stdinText,
    timeoutMs
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(describeCliFailure(["submit", "--json"], result));
  }
  return parseCliVerdict(result.stdout);
}
async function runPlannotatorReviewTool(args, context, env, options = {}) {
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
    const targetAgent = verdict.agentSwitch && verdict.agentSwitch !== "disabled" ? verdict.agentSwitch : undefined;
    const message = buildReviewFeedbackMessage(verdict.approved, verdict.feedback);
    if (options.promptSessionOnCompletion) {
      await maybePromptSession(env.client, context.sessionID, message, targetAgent);
    }
    return verdict.approved ? `Code review completed with notes.

${verdict.feedback}` : `Code review feedback received.

${verdict.feedback}`;
  }
  return "Code review completed with no requested changes.";
}
async function runPlannotatorAnnotateTool(args, context, env, options = {}) {
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
    return `Annotation feedback received for ${args.file_path}.

${verdict.feedback}`;
  }
  return `Annotation completed for ${args.file_path} with no requested changes.`;
}

// index.ts
var DEFAULT_PLAN_TIMEOUT_SECONDS = 345600;
var PlannotatorPlugin = async (ctx) => {
  function getPlanTimeoutSeconds() {
    const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
    if (!raw)
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`);
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    }
    if (parsed === 0)
      return null;
    return parsed;
  }
  return {
    config: async (opencodeConfig) => {
      const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
      const requiredPrimaryTools = [
        "submit_plan",
        "plannotator_review",
        "plannotator_annotate"
      ];
      const missingPrimaryTools = requiredPrimaryTools.filter((toolName) => !existingPrimaryTools.includes(toolName));
      if (missingPrimaryTools.length > 0) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, ...missingPrimaryTools]
        };
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const existingSystem = output.system.join(`
`).toLowerCase();
      if (existingSystem.includes("title generator") || existingSystem.includes("generate a title")) {
        return;
      }
      try {
        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;
        let lastUserAgent;
        if (messages) {
          for (let i = messages.length - 1;i >= 0; i--) {
            const msg = messages[i];
            if (msg.info.role === "user") {
              lastUserAgent = msg.info.agent;
              break;
            }
          }
        }
        if (!lastUserAgent)
          return;
        if (lastUserAgent === "build")
          return;
        const agentsResponse = await ctx.client.app.agents({
          query: { directory: ctx.directory }
        });
        const agents = agentsResponse.data;
        const agent = agents?.find((a) => a.name === lastUserAgent);
        if (agent?.mode === "subagent")
          return;
      } catch {
        return;
      }
      output.system.push(`
## Plan Submission

When you have completed your plan, you MUST call the \`submit_plan\` tool to submit it for user review.
The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

If your plan is rejected, you will receive the user's annotated feedback. Revise your plan
based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.
`);
    },
    event: async ({ event }) => {
      const isCommandEvent = event.type === "command.executed" || event.type === "tui.command.execute";
      const commandName = event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";
      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({
          level: "info",
          message: "Opening code review UI..."
        });
        const sessionID = event.properties?.sessionID;
        if (!sessionID) {
          return;
        }
        const message = await runPlannotatorReviewTool({ diff_type: "uncommitted" }, {
          sessionID,
          messageID: "",
          agent: "build",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {}
        }, {
          client: ctx.client,
          directory: ctx.directory
        }, { promptSessionOnCompletion: true });
        ctx.client.app.log({
          level: "info",
          message
        });
      }
    },
    tool: {
      submit_plan: tool({
        description: "Submit your completed plan for interactive user review. The user can annotate, approve, or request changes. Call this when you have finished creating your implementation plan.",
        args: {
          plan: tool.schema.string().describe("The complete implementation plan in markdown format"),
          summary: tool.schema.string().describe("A brief 1-2 sentence summary of what the plan accomplishes"),
          commit_message: tool.schema.string().describe("A commit message summarizing what has changed since the previous version of this plan. If this is a revision of a previously rejected plan, explain what feedback was addressed.")
        },
        async execute(args, context) {
          const timeoutSeconds = getPlanTimeoutSeconds();
          const timeoutMs = timeoutSeconds === null ? null : timeoutSeconds * 1000;
          let result;
          try {
            result = await runPlannotatorSubmitCli({
              plan: args.plan,
              commit_message: args.commit_message
            }, {
              client: ctx.client,
              directory: ctx.directory
            }, timeoutMs);
          } catch (error) {
            if (error instanceof CliTimeoutError) {
              return `[Plannotator] No response within ${timeoutSeconds} seconds. Please call submit_plan again.`;
            }
            throw error;
          }
          if (result.cancelled) {
            return `Plan review cancelled by user.`;
          }
          if (result.approved) {
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== "disabled";
            const targetAgent = result.agentSwitch || "build";
            if (shouldSwitchAgent) {
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" }
                });
              } catch {}
              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }]
                  }
                });
              } catch {}
            }
            if (result.feedback) {
              return `Plan approved with notes!

Plan Summary: ${args.summary}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }
            return `Plan approved!

Plan Summary: ${args.summary}`;
          } else {
            return `Plan needs revision.

The user has requested changes to your plan. Please review their feedback below and revise your plan accordingly.

## User Feedback

${result.feedback}

---

Please revise your plan based on this feedback and call \`submit_plan\` again when ready.`;
          }
        }
      }),
      plannotator_review: tool({
        description: "Present git diff changes to the user for live code review and feedback. Use this whenever you want to show code changes to the user so they can review and annotate specific lines.",
        args: {
          diff_type: tool.schema.enum(REVIEW_TOOL_DIFF_TYPES).optional().describe("Diff to review: uncommitted, staged, unstaged, last-commit, or branch")
        },
        async execute(args, context) {
          return runPlannotatorReviewTool(args, context, {
            client: ctx.client,
            directory: ctx.directory
          });
        }
      }),
      plannotator_annotate: tool({
        description: "Present a markdown document to the user for live annotation and feedback. Use this whenever you want to show a markdown file to the user so they can review, annotate, and give corrections in real time.",
        args: {
          file_path: tool.schema.string().describe("Path to the markdown file to present for annotation")
        },
        async execute(args, context) {
          return runPlannotatorAnnotateTool(args, context, {
            client: ctx.client,
            directory: ctx.directory
          });
        }
      })
    }
  };
};
var opencode_plugin_default = PlannotatorPlugin;
export {
  opencode_plugin_default as default,
  PlannotatorPlugin
};
