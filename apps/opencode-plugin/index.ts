/**
 * Plannotator Plugin for OpenCode
 *
 * POC: Edit-based submit_plan. The tool accepts line-range edits instead of
 * full plan text or file paths. A backing file is managed by the plugin;
 * the agent never touches it directly. On denial, the tool response includes
 * the plan with line numbers so the agent can target surgical edits.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for approval (default: 345600, set 0 to disable)
 *   PLANNOTATOR_ALLOW_SUBAGENTS - Set to "1" to allow subagents to see submit_plan
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin/v1";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, resolveSharingEnabled } from "@plannotator/shared/config";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import {
  composeSystemPrompt,
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
  type RuntimeMode,
  type PlannotatorOpenCodeOptions,
} from "./workflow";
import {
  handleCliCommand,
  runCliPlanReview,
  type OpenCodeBridgeContext,
  type OpenCodePlanReviewResult,
} from "./cli-bridge";
import { resolveValidatedTargetAgent } from "./agent-switch";
import { shouldFallbackAfterEmbeddedError } from "./prompt-delivery-error";
import { executeSubmitPlan } from "./submit-plan-executor";
import { getPlanningPrompt } from "./planning-prompt";

// Lazy-load HTML at first use instead of embedding in the bundle.
// The two SPA files are ~20 MB combined — inlining them as string literals
// adds ~160ms to module parse time (see GitHub issue #410).
let _planHtml: string | null = null;
let _reviewHtml: string | null = null;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveBundledHtmlPath(filename: string): string {
  const candidates = [
    path.join(moduleDir, filename),
    path.join(moduleDir, "..", filename),
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

function getBunRuntime(): { serve?: unknown; sleep?: (ms: number) => Promise<void> } | undefined {
  return (globalThis as typeof globalThis & {
    Bun?: { serve?: unknown; sleep?: (ms: number) => Promise<void> };
  }).Bun;
}

function hasEmbeddedRuntime(): boolean {
  return typeof getBunRuntime()?.serve === "function";
}

function shouldUseEmbeddedRuntime(runtime: RuntimeMode): boolean {
  return runtime !== "cli" && hasEmbeddedRuntime();
}

function getEmbeddedRuntimeError(): string {
  return "runtime \"embedded\" requires a Bun-hosted OpenCode plugin runtime. Use runtime \"auto\" or \"cli\" with this OpenCode host.";
}

function logPlannotatorReady(client: any, label: string, url: string): void {
  try {
    void client.app.log({ level: "info", message: `[Plannotator] Open ${label}: ${url}` });
  } catch {
    // OpenCode logging is best-effort.
  }
  // app.log only reaches OpenCode's server log file — never the TUI. Toast the
  // URL too so remote users (no auto-opened browser) actually see it.
  // Best-effort: older hosts without /tui/show-toast just no-op.
  try {
    const result = client.tui?.showToast?.({
      body: { title: "Plannotator", message: `Open ${label}: ${url}`, variant: "info" },
    });
    // A fetch-level failure (host restarting) rejects the SDK promise; swallow
    // it so a cosmetic toast can never surface an unhandled rejection.
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Toast delivery is best-effort.
  }
}

type EmbeddedRuntimeModule = {
  runEmbeddedPlanReview: (input: {
    client: any;
    planContent: string;
    sharingEnabled: boolean;
    shareBaseUrl?: string;
    pasteApiUrl?: string;
    htmlContent: string;
    timeoutSeconds: number | null;
    abortSignal: AbortSignal;
    logReady: (url: string, isRemote: boolean, port: number) => void;
  }) => Promise<OpenCodePlanReviewResult>;
  handleEmbeddedCommand: (
    command: string,
    event: any,
    deps: {
      client: any;
      htmlContent: string;
      reviewHtmlContent: string;
      getSharingEnabled: () => Promise<boolean>;
      getShareBaseUrl: () => string | undefined;
      getPasteApiUrl: () => string | undefined;
      directory?: string;
    },
  ) => Promise<{ feedback?: string | null }>;
};

async function importEmbeddedRuntime(): Promise<EmbeddedRuntimeModule> {
  const builtPath = path.join(moduleDir, "embedded.js");
  if (existsSync(builtPath)) {
    return await import(pathToFileURL(builtPath).href) as EmbeddedRuntimeModule;
  }
  const sourceSpecifier = "./embedded";
  return await import(sourceSpecifier) as EmbeddedRuntimeModule;
}

/** Run one OpenCode plan review in the configured runtime. */
async function runPlanReview(input: {
  client: any;
  runtime: RuntimeMode;
  planContent: string;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  htmlContent: string;
  timeoutSeconds: number | null;
  abortSignal: AbortSignal;
  cwd?: string;
  bridge: OpenCodeBridgeContext;
}): Promise<OpenCodePlanReviewResult> {
  input.abortSignal.throwIfAborted();
  if (input.runtime === "embedded" && !hasEmbeddedRuntime()) {
    throw new Error(getEmbeddedRuntimeError());
  }

  if (shouldUseEmbeddedRuntime(input.runtime)) {
    try {
      const embedded = await importEmbeddedRuntime();
      return await embedded.runEmbeddedPlanReview({
        client: input.client,
        planContent: input.planContent,
        sharingEnabled: input.sharingEnabled,
        shareBaseUrl: input.shareBaseUrl,
        pasteApiUrl: input.pasteApiUrl,
        htmlContent: input.htmlContent,
        timeoutSeconds: input.timeoutSeconds,
        abortSignal: input.abortSignal,
        logReady: (url) => logPlannotatorReady(input.client, "plan review", url),
      });
    } catch (error) {
      input.abortSignal.throwIfAborted();
      if (input.runtime === "embedded") throw error;
      try {
        void input.client.app.log({
          level: "error",
          message: `[Plannotator] Embedded runtime unavailable; falling back to CLI: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {}
    }
  }

  return await runCliPlanReview({
    client: input.client,
    planContent: input.planContent,
    cwd: input.cwd,
    timeoutSeconds: input.timeoutSeconds,
    abortSignal: input.abortSignal,
    bridge: input.bridge,
  });
}

const PlannotatorPlugin: Plugin = async (ctx, rawOptions?: PlannotatorOpenCodeOptions) => {
  const workflowOptions = normalizeWorkflowOptions(rawOptions);

  // Preload HTML in background — populates the sync cache before first use
  readFile(resolveBundledHtmlPath("plannotator.html"), "utf-8").then(h => { _planHtml = h; }).catch(() => {});
  readFile(resolveBundledHtmlPath("review-editor.html"), "utf-8").then(h => { _reviewHtml = h; }).catch(() => {});

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
      // Config read failed, fall through to env var / plannotator config
    }
    return resolveSharingEnabled(loadConfig());
  }

  function getShareBaseUrl(): string | undefined {
    return process.env.PLANNOTATOR_SHARE_URL || undefined;
  }

  function getPasteApiUrl(): string | undefined {
    return process.env.PLANNOTATOR_PASTE_URL || undefined;
  }

  async function getOpenCodeAgents(): Promise<any[] | undefined> {
    try {
      if (!cachedAgents) {
        const response = await ctx.client.app.agents({
          query: { directory: ctx.directory },
        });
        cachedAgents = response.data ?? [];
      }
      return cachedAgents;
    } catch {
      return undefined;
    }
  }

  async function getBridgeContext(): Promise<OpenCodeBridgeContext> {
    return {
      sharingEnabled: await getSharingEnabled(),
      shareBaseUrl: getShareBaseUrl(),
      pasteApiUrl: getPasteApiUrl(),
      agents: await getOpenCodeAgents(),
    };
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
        const hook = readImprovementHook("enterplanmode-improve");
        const pfmEnabled = loadConfig().pfmReminder === true;
        const improveContext = composeImproveContext({
          pfmEnabled,
          improvementHookContent: hook?.content ?? null,
        });
        const parts = [...stripped, getPlanningPrompt()];
        if (improveContext) parts.push(improveContext);
        output.system.length = 0;
        output.system.push(...composeSystemPrompt([], parts));

        return;
      }

      if (!shouldInjectGenericPlanReminder(lastUserAgent, isSubagent, workflowOptions)) return;

      const planSubmissionReminder = `## Plan Submission

When you have completed your plan, call the \`submit_plan\` tool to submit it for user review. Pass your full plan as a single edit: \`{ "edits": [{ "start": 1, "content": "..." }] }\`.

The user will review your plan in a visual UI where they can annotate, approve, or request changes. If rejected, the response includes your plan with line numbers; use targeted edits to revise specific sections.

Do NOT proceed with implementation until your plan is approved.`;
      const composed = composeSystemPrompt(output.system, [planSubmissionReminder]);
      output.system.length = 0;
      output.system.push(...composed);
    },

    // Intercept plannotator commands before the agent sees them.
    // Clearing output.parts in place suppresses the .md body + appended
    // args so the agent never receives the command — without this, OpenCode
    // calls resolvePromptParts() on "<body> <arguments>", which auto-attaches
    // any file path it finds as a FilePart. On a large file that blows the
    // context before the annotation UI even opens (#713).
    //
    // Must mutate in place (length = 0), not reassign (= []). The caller
    // holds a reference to the parts array directly and ignores any new
    // array assigned to output.parts.
    "command.execute.before": async (input, output) => {
      const cmd = input.command;
      if (
        cmd !== "plannotator-last" &&
        cmd !== "plannotator-annotate" &&
        cmd !== "plannotator-review"
      ) return;

      output.parts.length = 0;

      // input.arguments is the raw tail string from OpenCode's command dispatcher —
      // needed so --gate / --json reach the handlers' parseAnnotateArgs.
      const event = {
        properties: { sessionID: input.sessionID, arguments: input.arguments },
      };

      if (shouldUseEmbeddedRuntime(workflowOptions.runtime)) {
        try {
          const embedded = await importEmbeddedRuntime();
          const deps = {
            client: ctx.client,
            htmlContent: getPlanHtml(),
            reviewHtmlContent: getReviewHtml(),
            getSharingEnabled,
            getShareBaseUrl,
            getPasteApiUrl,
            directory: ctx.directory,
          };
          const result = await embedded.handleEmbeddedCommand(cmd, event, deps);
          if (cmd === "plannotator-last" && result.feedback) {
            await embedded.deliverEmbeddedAnnotateMessagePrompt({
              client: ctx.client,
              sessionId: input.sessionID,
              approved: Boolean(result.approved),
              feedback: result.feedback,
            });
          }
          return;
        } catch (error) {
          if (!shouldFallbackAfterEmbeddedError(workflowOptions.runtime, error)) {
            throw error;
          }
          try {
            void ctx.client.app.log({
              level: "error",
              message: `[Plannotator] Embedded runtime unavailable; falling back to CLI: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch {}
        }
      }

      if (workflowOptions.runtime === "embedded" && !hasEmbeddedRuntime()) {
        try {
          void ctx.client.app.log({
            level: "error",
            message: `[Plannotator] ${getEmbeddedRuntimeError()}`,
          });
        } catch {}
        return;
      }

      await handleCliCommand({
        command: cmd,
        client: ctx.client,
        sessionId: input.sessionID,
        rawArgs: input.arguments ?? "",
        cwd: ctx.directory,
        bridge: await getBridgeContext(),
      });
    },
  };

  if (shouldRegisterSubmitPlan(workflowOptions)) {
    plugin.tool = {
      submit_plan: tool({
        description:
          "Submit a plan for user review via line-range edits. First call: pass a single edit with start=1 and your full plan as content (omit end). Subsequent calls after denial: pass targeted edits using the line numbers from the previous response. The tool manages a backing file; you never touch the file directly.",
        args: {
          edits: tool.schema
            .array(
              tool.schema.object({
                start: tool.schema.number().describe("1-indexed start line (inclusive)"),
                end: tool.schema.number().optional().describe("1-indexed end line (inclusive). Omit to replace from start through end of file."),
                content: tool.schema.string().describe("Replacement content. Empty string deletes the line range."),
              }),
            )
            .describe("Array of line-range edits to apply to the plan."),
        },

        async execute(args, context) {
          return await executeSubmitPlan({
            edits: args.edits,
            invokingAgent: context.agent,
            sessionId: context.sessionID,
            abortSignal: context.abort,
            directory: ctx.directory,
            workflowOptions,
          }, {
            reviewPlan: async ({ planContent }) => await runPlanReview({
              client: ctx.client,
              runtime: workflowOptions.runtime,
              planContent,
              sharingEnabled: await getSharingEnabled(),
              shareBaseUrl: getShareBaseUrl(),
              pasteApiUrl: getPasteApiUrl(),
              htmlContent: getPlanHtml(),
              timeoutSeconds: getPlanTimeoutSeconds(),
              abortSignal: context.abort,
              cwd: ctx.directory,
              bridge: await getBridgeContext(),
            }),
            resolveTargetAgent: async ({ requestedAgent, directory, delivery }) =>
              await resolveValidatedTargetAgent({
                client: ctx.client,
                targetAgent: requestedAgent,
                directory,
                delivery,
              }),
            sendApprovalHandoff: async ({ sessionId, targetAgent, text }) => {
              await ctx.client.session.prompt({
                path: { id: sessionId },
                body: {
                  agent: targetAgent,
                  noReply: true,
                  parts: [{ type: "text", text }],
                },
              });
            },
          });
        },
      }),
    };
  }

  return plugin;
};

export default PlannotatorPlugin;
