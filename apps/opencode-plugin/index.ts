/**
 * Plannotator Plugin for OpenCode
 *
 * Provides interactive browser-based plan review via a single tool:
 *   submit_plan(plan) — accepts either markdown text or a file path
 *
 * First submission: agent passes plan as text. On deny, the response includes
 * the path where the plan was saved, enabling the agent to use Edit for targeted
 * revisions and resubmit with the file path.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for approval (default: 345600, set 0 to disable)
 *   PLANNOTATOR_ALLOW_SUBAGENTS - Set to "1" to allow subagents to see submit_plan
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "fs";
import path from "path";

// OpenCode's @hono/node-server patches global.Response with a polyfill that
// Bun.serve() doesn't accept (it checks native type tags, not instanceof).
// This happens in "opencode web" and "opencode serve" modes, where
// createAdaptorServer() runs before plugins load. Recover the native Response
// from the polyfill's prototype chain — hono sets up:
//   Object.setPrototypeOf(Response2.prototype, GlobalResponse.prototype)
// so the parent prototype's constructor IS the original native Response.
const _proto = Object.getPrototypeOf(Response.prototype);
if (_proto?.constructor && _proto.constructor !== Response && _proto.constructor !== Object) {
  globalThis.Response = _proto.constructor;
  // Also fix Request — hono patches both with the same pattern
  const _reqProto = Object.getPrototypeOf(Request.prototype);
  if (_reqProto?.constructor && _reqProto.constructor !== Request && _reqProto.constructor !== Object) {
    globalThis.Request = _reqProto.constructor;
  }
}
import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import {
  handleReviewCommand,
  handleAnnotateCommand,
  handleAnnotateLastCommand,
  handleArchiveCommand,
  type CommandDeps,
} from "./commands";
import {
  getPlanDeniedPrompt,
  getPlanApprovedPrompt,
  getPlanApprovedWithNotesPrompt,
  getPlanToolName,
  buildPlanFileRule,
  getAnnotateMessageFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { loadConfig } from "@plannotator/shared/config";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import {
  stripConflictingPlanModeRules,
} from "./plan-mode";
import {
  applyWorkflowConfig,
  isPlanningAgent,
  normalizeWorkflowOptions,
  shouldApplyToolDefinitionRewrites,
  shouldInjectFullPlanningPrompt,
  shouldInjectGenericPlanReminder,
  shouldModifyPrompts,
  shouldRegisterSubmitPlan,
  shouldRejectSubmitPlanForAgent,
  type PlannotatorOpenCodeOptions,
} from "./workflow";

// Lazy-load HTML at first use instead of embedding in the bundle.
// The two SPA files are ~20 MB combined — inlining them as string literals
// adds ~160ms to module parse time (see GitHub issue #410).
let _planHtml: string | null = null;
let _reviewHtml: string | null = null;

function resolveBundledHtmlPath(filename: string): string {
  const candidates = [
    path.join(import.meta.dir, filename),
    path.join(import.meta.dir, "..", filename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find bundled HTML asset: ${filename}`);
}

function readBundledHtml(filename: string): string {
  return readFileSync(resolveBundledHtmlPath(filename), "utf-8");
}

function getPlanHtml(): string {
  if (!_planHtml) _planHtml = readBundledHtml("plannotator.html");
  return _planHtml;
}

function getReviewHtml(): string {
  if (!_reviewHtml) _reviewHtml = readBundledHtml("review-editor.html");
  return _reviewHtml;
}

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600; // 96 hours

// ── Auto-detection ────────────────────────────────────────────────────────

/**
 * Detect whether the submit_plan argument is a file path.
 * Must be an absolute path, end in .md, and exist on disk.
 * Anything that doesn't match is treated as plan text.
 */
function isFilePath(value: string): boolean {
  return path.isAbsolute(value) && value.endsWith(".md") && existsSync(value);
}

/**
 * Resolve the plan content from the submit_plan argument.
 * Returns the markdown text and optionally the source file path.
 */
function resolvePlanContent(plan: string): { content: string; filePath?: string } {
  if (isFilePath(plan)) {
    const content = readFileSync(plan, "utf-8");
    if (!content.trim()) {
      throw new Error(`Plan file at ${plan} is empty. Write your plan content first, then call submit_plan.`);
    }
    return { content, filePath: plan };
  }
  // Catch typos: looks like a file path but doesn't exist
  if (path.isAbsolute(plan) && plan.endsWith(".md")) {
    throw new Error(`File not found: ${plan}. Check the path and try again.`);
  }
  return { content: plan };
}

// ── Planning prompt ───────────────────────────────────────────────────────

/**
 * Unified planning prompt injected for all primary agents.
 *
 * Design principles:
 * - Explain the WHY — the model is smart, give it context
 * - Keep it lean — every line should pull its weight
 * - Don't overfit — let the agent and user dictate the workflow
 * - One tool, two modes — text for first submission, file path for revisions
 */
function getPlanningPrompt(): string {
  return `## Plannotator — Plan Review

You have a plan submission tool called \`submit_plan\`. It opens an interactive review UI where the user can annotate, approve, or request changes.

**How to use it:**

- Pass your plan as markdown text — \`submit_plan(plan: "# My Plan\\n...")\`.
- Or pass an absolute file path to a .md file — \`submit_plan(plan: "/path/to/plan.md")\`.

The tool auto-detects whether you passed text or a file path. Both open the same review UI.

### Before you write a plan

Do not jump straight to writing a plan. First:

1. **Explore** — Read the relevant code, trace dependencies, and look at existing patterns. The depth should match the task.
2. **Ask questions** — If you need information only the user can provide (requirements, preferences, tradeoffs), ask using the \`question\` tool. Don't guess at ambiguous requirements.

Only write and submit a plan once you have sufficient context.

### What NOT to do

- Don't proceed with implementation until the plan is approved.
- Don't use \`plan_exit\` — use \`submit_plan\` instead.
- Don't end your turn without either submitting a plan or asking the user a question.`;
}

// ── Plugin ────────────────────────────────────────────────────────────────

function getLastUserAgentFromMessages(messages: any[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role === "user" && typeof msg.info.agent === "string") {
      return msg.info.agent;
    }
  }
  return undefined;
}

export const PlannotatorPlugin: Plugin = async (ctx, rawOptions?: PlannotatorOpenCodeOptions) => {
  const workflowOptions = normalizeWorkflowOptions(rawOptions);

  // Preload HTML in background — populates the sync cache before first use
  Bun.file(resolveBundledHtmlPath("plannotator.html")).text().then(h => { _planHtml = h; });
  Bun.file(resolveBundledHtmlPath("review-editor.html")).text().then(h => { _reviewHtml = h; });

  let cachedAgents: any[] | null = null;

  async function getSharingEnabled(): Promise<boolean> {
    try {
      const response = await ctx.client.config.get({ query: { directory: ctx.directory } });
      // @ts-ignore - share config may exist
      const share = response?.data?.share;
      if (share !== undefined) {
        return share !== "disabled";
      }
    } catch {
      // Config read failed, fall through to env var
    }
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }

  function getShareBaseUrl(): string | undefined {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }

  function getPasteApiUrl(): string | undefined {
    return process.env.PLANNOTATOR_PASTE_URL || undefined;
  }

  function getPlanTimeoutSeconds(): number | null {
    const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
    if (!raw) return DEFAULT_PLAN_TIMEOUT_SECONDS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(
        `[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`
      );
      return DEFAULT_PLAN_TIMEOUT_SECONDS;
    }

    if (parsed === 0) return null;
    return parsed;
  }

  function allowSubagents(): boolean {
    const val = process.env.PLANNOTATOR_ALLOW_SUBAGENTS?.trim();
    return val === "1" || val === "true";
  }

  const plugin: any = {
    config: async (opencodeConfig) => {
      applyWorkflowConfig(opencodeConfig, workflowOptions, allowSubagents());
    },

    // Replace OpenCode's "STRICTLY FORBIDDEN" plan mode prompt with a version
    // that allows markdown file writing. OpenCode's original blocks ALL file edits,
    // but we need the agent to write plans, specs, docs, etc.
    "experimental.chat.messages.transform": async (input, output) => {
      if (!shouldModifyPrompts(workflowOptions)) return;

      const lastUserAgent = getLastUserAgentFromMessages(output.messages);
      if (
        workflowOptions.workflow === "plan-agent"
        && !isPlanningAgent(lastUserAgent, workflowOptions)
      ) {
        return;
      }

      for (const message of output.messages) {
        if (message.info.role !== "user") continue;
        for (const part of message.parts as any[]) {
          if (part.type !== "text" || !part.text?.includes("STRICTLY FORBIDDEN")) continue;
          part.text = `<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE. You are in a PLANNING phase. The ONLY file modifications
allowed are writing or editing markdown files (.md) — plans, specs, documentation, etc.
All other file edits, code modifications, and system changes are STRICTLY FORBIDDEN.
Do NOT use bash commands to manipulate non-markdown files. Commands may ONLY read/inspect.

## Responsibility

Your responsibility is to think, read, search, and delegate explore agents to construct
a well-formed plan. Ask the user clarifying questions and surface tradeoffs rather than
making assumptions about intent. Use submit_plan to submit your plan for user review.

## Important

The user wants a plan, not execution. You MUST NOT edit source code, run non-readonly
tools (except writing markdown files), or otherwise make changes to the system.
</system-reminder>`;
        }
      }
    },

    // Suppress plan_exit — redirect to submit_plan
    // Override todowrite — defer to submit_plan during planning
    "tool.definition": async (input, output) => {
      if (!shouldApplyToolDefinitionRewrites(workflowOptions)) return;

      if (input.toolID === "plan_exit") {
        output.description =
          "Do not call this tool. Use submit_plan instead — it opens a visual review UI for plan approval.";
      }
      if (input.toolID === "todowrite") {
        output.description =
          "While actively planning with the user, use submit_plan instead. Only use todos once implementation begins or unless the user explicitly asks.";
      }
    },

    // Inject planning instructions into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      if (!shouldModifyPrompts(workflowOptions)) return;

      const systemText = output.system.join("\n");
      if (systemText.toLowerCase().includes("title generator") || systemText.toLowerCase().includes("generate a title")) {
        return;
      }

      let lastUserAgent: string | undefined;
      let isSubagent = false;
      try {
        const messagesResponse = await ctx.client.session.messages({
          // @ts-ignore - sessionID exists on input
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;

        lastUserAgent = getLastUserAgentFromMessages(messages);

        if (!lastUserAgent) return;

        // Cache agents list (static per session)
        if (!cachedAgents) {
          const agentsResponse = await ctx.client.app.agents({
            query: { directory: ctx.directory }
          });
          cachedAgents = agentsResponse.data ?? [];
        }
        const agent = cachedAgents.find((a: { name: string }) => a.name === lastUserAgent);

        // @ts-ignore - Agent has mode field
        isSubagent = agent?.mode === "subagent";

      } catch {
        return;
      }

      if (shouldInjectFullPlanningPrompt(lastUserAgent, workflowOptions)) {
        const stripped = stripConflictingPlanModeRules(output.system);
        output.system.length = 0;
        output.system.push(...stripped);
        output.system.push(getPlanningPrompt());

        const hook = readImprovementHook("enterplanmode-improve");
        const pfmEnabled = loadConfig().pfmReminder === true;
        const improveContext = composeImproveContext({
          pfmEnabled,
          improvementHookContent: hook?.content ?? null,
        });
        if (improveContext) {
          output.system.push(improveContext);
        }

        return;
      }

      if (!shouldInjectGenericPlanReminder(lastUserAgent, isSubagent, workflowOptions)) return;

      output.system.push(`## Plan Submission

When you have completed your plan, call the \`submit_plan\` tool to submit it for user review. Pass your plan as markdown text, or pass an absolute file path to a .md file.

The user will review your plan in a visual UI where they can annotate, approve, or request changes. If rejected, revise based on their feedback and call submit_plan again.

Do NOT proceed with implementation until your plan is approved.`);
    },

    // Intercept plannotator-last before the agent sees the command
    "command.execute.before": async (input, output) => {
      if (input.command !== "plannotator-last") return;

      output.parts = [];

      const deps: CommandDeps = {
        client: ctx.client,
        htmlContent: getPlanHtml(),
        reviewHtmlContent: getReviewHtml(),
        getSharingEnabled,
        getShareBaseUrl,
        getPasteApiUrl,
        directory: ctx.directory,
      };

      const feedback = await handleAnnotateLastCommand(
        // input.arguments is the raw tail string from OpenCode's command dispatcher —
        // needed so --gate / --json reach handleAnnotateLastCommand's parseAnnotateArgs (#570).
        { properties: { sessionID: input.sessionID, arguments: input.arguments } },
        deps
      );

      if (feedback) {
        try {
          await ctx.client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{
                type: "text",
                text: getAnnotateMessageFeedbackPrompt("opencode", undefined, { feedback }),
              }],
            },
          });
        } catch {
          // Session may not be available
        }
      }
    },

    // Listen for slash commands (review + annotate)
    event: async ({ event }) => {
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      if (!isCommandEvent) return;

      // @ts-ignore - Event structure varies
      const commandName = event.properties?.name || event.command || event.payload?.name;

      const deps: CommandDeps = {
        client: ctx.client,
        htmlContent: getPlanHtml(),
        reviewHtmlContent: getReviewHtml(),
        getSharingEnabled,
        getShareBaseUrl,
        getPasteApiUrl,
        directory: ctx.directory,
      };

      if (commandName === "plannotator-review")
        return handleReviewCommand(event, deps);
      if (commandName === "plannotator-annotate")
        return handleAnnotateCommand(event, deps);
      if (commandName === "plannotator-archive")
        return handleArchiveCommand(event, deps);
    },
  };

  if (shouldRegisterSubmitPlan(workflowOptions)) {
    plugin.tool = {
      submit_plan: tool({
        description:
          "Planning tool used to submit a plan to the user for review. Before calling this tool you must conduct interactive and exploratory analysis in order to submit a quality plan. Ask questions. Explore the codebase for context if needed. Only call submit_plan once you have enough details to create a quality plan. Work with the user to get those details. Pass either markdown text or an absolute path to a .md file.",
        args: {
          plan: tool.schema
            .string()
            .describe("The plan — either markdown text or an absolute path to a .md file on disk."),
        },

        async execute(args, context) {
          const invokingAgent = (context as { agent?: string }).agent;
          if (shouldRejectSubmitPlanForAgent(invokingAgent, workflowOptions)) {
            return `Plannotator is configured for plan-agent mode. submit_plan can only be called by: ${workflowOptions.planningAgents.join(", ")}.

Use /plannotator-last or /plannotator-annotate for manual review, or set workflow to all-agents to allow broader submit_plan access.`;
          }

          // Auto-detect: file path or plan text
          let planContent: string;
          let sourceFilePath: string | undefined;
          try {
            const resolved = resolvePlanContent(args.plan);
            planContent = resolved.content;
            sourceFilePath = resolved.filePath;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          if (!planContent.trim()) {
            return "Error: Plan content is empty. Write your plan first, then call submit_plan.";
          }

          const sharingEnabled = await getSharingEnabled();
          const server = await startPlannotatorServer({
            plan: planContent,
            origin: "opencode",
            sharingEnabled,
            shareBaseUrl: getShareBaseUrl(),
            pasteApiUrl: getPasteApiUrl(),
            htmlContent: getPlanHtml(),
            opencodeClient: ctx.client,
            onReady: async (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
              if (isRemote) {
                ctx.client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
              }
            },
          });

          const timeoutSeconds = getPlanTimeoutSeconds();
          const timeoutMs = timeoutSeconds === null ? null : timeoutSeconds * 1000;

          const result = timeoutMs === null
            ? await server.waitForDecision()
            : await new Promise<Awaited<ReturnType<typeof server.waitForDecision>>>((resolve) => {
                const timeoutId = setTimeout(
                  () =>
                    resolve({
                      approved: false,
                      feedback: `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`,
                    }),
                  timeoutMs
                );

                server.waitForDecision().then((r) => {
                  clearTimeout(timeoutId);
                  resolve(r);
                });
              });
          await Bun.sleep(1500);
          server.stop();

          if (result.approved) {
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            if (shouldSwitchAgent) {
              try {
                await ctx.client.session.prompt({
                  path: { id: context.sessionID },
                  body: {
                    agent: targetAgent,
                    noReply: true,
                    parts: [{ type: "text", text: "Proceed with implementation" }],
                  },
                });
              } catch {
                // Silently fail if session is busy
              }
            }

            if (result.feedback) {
              return getPlanApprovedWithNotesPrompt("opencode", undefined, {
                planFilePath: sourceFilePath,
                doneMsg: result.savedPath ? `Saved to: ${result.savedPath}` : "",
                feedback: result.feedback,
                proceedSuffix: shouldSwitchAgent
                  ? "\n\nProceed with implementation, incorporating these notes where applicable."
                  : "",
              });
            }

            return getPlanApprovedPrompt("opencode", undefined, {
              planFilePath: sourceFilePath,
              doneMsg: result.savedPath ? ` Saved to: ${result.savedPath}` : "",
            });
          } else {
            return getPlanDeniedPrompt("opencode", undefined, {
              toolName: getPlanToolName("opencode"),
              planFileRule: buildPlanFileRule(getPlanToolName("opencode"), sourceFilePath),
              feedback: result.feedback || "Plan changes requested",
            }) + "\n\nAfter making your revisions, call `submit_plan` again to resubmit for review.";
          }
        },
      }),
    };
  }

  return plugin;
};

export default PlannotatorPlugin;
