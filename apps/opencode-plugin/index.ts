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

import { type Plugin, tool } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

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
  getAnnotateMessageFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { loadConfig } from "@plannotator/shared/config";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import {
  stripConflictingPlanModeRules,
} from "./plan-mode";
import { sanitizeTag } from "@plannotator/shared/project";
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
const MAX_PLAN_SIZE = 5 * 1024 * 1024; // 5MB

// ── Edit-based plan management ────────────────────────────────────────────

interface PlanEdit {
  start: number;
  end?: number | null;
  content: string;
}

/**
 * Backing file for the current plan. Stored outside the workspace in
 * `~/.plannotator/active/{project}/_active-plan.md` so it never appears
 * in git status or editor file trees. Managed entirely by the plugin;
 * the agent never sees or touches this file directly.
 */
export function getPlanBackingPath(project: string): string {
  return path.join(getPlannotatorDataDir(), "active", project, "_active-plan.md");
}

/**
 * Apply line-range edits to a plan stored as an array of lines.
 *
 * Edit semantics:
 *   - start/end are 1-indexed line numbers (inclusive)
 *   - end omitted or null: replace from start through end of file
 *     (on first call with start=1, this writes the entire plan)
 *   - content="" with start/end: delete those lines
 *   - edits are applied in order; line numbers refer to the document
 *     state BEFORE any edits in this batch (offsets are adjusted internally)
 */
export function applyEdits(existingLines: string[], edits: PlanEdit[]): string[] {
  // Sort by start ascending so offset adjustment works correctly
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const lines = [...existingLines];
  let offset = 0;

  for (const edit of sorted) {
    const start = edit.start - 1 + offset; // convert to 0-indexed + adjust
    const end = edit.end != null
      ? edit.end + offset   // end is inclusive, so this becomes the exclusive upper bound
      : lines.length;       // null/omitted = through end of file

    const newLines = edit.content ? edit.content.split("\n") : [];
    const removedCount = end - start;
    lines.splice(start, removedCount, ...newLines);
    offset += newLines.length - removedCount;
  }

  return lines;
}

/**
 * Validate a batch of edits against the current file state.
 * Returns an error string if invalid, or null if all edits are acceptable.
 */
export function validateEdits(existingLines: string[], edits: PlanEdit[]): string | null {
  const lineCount = existingLines.length;

  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || edit.start < 1) {
      return `start must be a positive integer >= 1, got ${edit.start}`;
    }
    if (edit.start > lineCount + 1) {
      return `start (${edit.start}) exceeds file length + 1 (${lineCount + 1})`;
    }
    if (edit.end != null) {
      if (!Number.isInteger(edit.end) || edit.end < edit.start) {
        return `end (${edit.end}) must be >= start (${edit.start})`;
      }
      // On an empty file (lineCount === 0) every edit is a pure insert;
      // end is semantically meaningless and applyEdits handles it via splice
      // clamping. Rejecting here breaks first-call payloads where the agent
      // or framework includes end (see #742).
      if (edit.end > lineCount && lineCount > 0) {
        return `end (${edit.end}) exceeds file length (${lineCount})`;
      }
    }
  }

  // Check for overlapping ranges (sorted by start ascending)
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    // Appending edits (start > lineCount) have no range that can overlap
    if (prev.start > lineCount) continue;
    const prevEnd = prev.end ?? lineCount;
    if (curr.start <= prevEnd) {
      return `edits overlap: [${prev.start},${prevEnd}] and [${curr.start},${curr.end ?? "end"}]`;
    }
  }

  return null;
}

/**
 * Format the plan content with line numbers for the agent's reference.
 * Returned in the tool response so the agent can track line positions.
 */
export function formatWithLineNumbers(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}| ${line}`)
    .join("\n");
}

// ── Planning prompt ───────────────────────────────────────────────────────

/**
 * Unified planning prompt injected for all primary agents.
 *
 * Design principles:
 * - Explain the WHY — the model is smart, give it context
 * - Keep it lean — every line should pull its weight
 * - Don't overfit — let the agent and user dictate the workflow
 * - Edit-based: all submissions use line-range edits against a backing file
 */
function getPlanningPrompt(): string {
  return `## Plannotator — Plan Review

You have a plan submission tool called \`submit_plan\`. It opens an interactive review UI where the user can annotate, approve, or request changes.

**How to use it:**

\`submit_plan\` accepts an array of line-range edits. On first submission, pass the full plan as a single edit starting at line 1:

\`\`\`json
{ "edits": [{ "start": 1, "content": "# My Plan\\n\\n## Goals\\n..." }] }
\`\`\`

If the user denies and requests changes, apply surgical edits using line ranges. The tool response includes your plan with line numbers so you can target specific ranges:

\`\`\`json
{ "edits": [
  { "start": 12, "end": 14, "content": "revised section content" },
  { "start": 30, "end": 30, "content": "" }
] }
\`\`\`

Edit semantics:
- \`start\` and \`end\` are 1-indexed, inclusive line numbers
- Omit \`end\` to replace from \`start\` through end of file (use this for the initial full write)
- Empty \`content\` with \`start\`/\`end\` deletes those lines
- Multiple edits in one call are applied in order; line numbers refer to the state before edits

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

When you have completed your plan, call the \`submit_plan\` tool to submit it for user review. Pass your full plan as a single edit: \`{ "edits": [{ "start": 1, "content": "..." }] }\`.

The user will review your plan in a visual UI where they can annotate, approve, or request changes. If rejected, the response includes your plan with line numbers; use targeted edits to revise specific sections.

Do NOT proceed with implementation until your plan is approved.`);
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
        cmd !== "plannotator-review" &&
        cmd !== "plannotator-archive"
      ) return;

      output.parts.length = 0;

      const deps: CommandDeps = {
        client: ctx.client,
        htmlContent: getPlanHtml(),
        reviewHtmlContent: getReviewHtml(),
        getSharingEnabled,
        getShareBaseUrl,
        getPasteApiUrl,
        directory: ctx.directory,
      };
      // input.arguments is the raw tail string from OpenCode's command dispatcher —
      // needed so --gate / --json reach the handlers' parseAnnotateArgs (#570).
      const event = {
        properties: { sessionID: input.sessionID, arguments: input.arguments },
      };

      if (cmd === "plannotator-last") {
        const feedback = await handleAnnotateLastCommand(event, deps);
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
        return;
      }

      if (cmd === "plannotator-annotate") return handleAnnotateCommand(event, deps);
      if (cmd === "plannotator-review") return handleReviewCommand(event, deps);
      if (cmd === "plannotator-archive") return handleArchiveCommand(event, deps);
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
          const invokingAgent = (context as { agent?: string }).agent;
          if (shouldRejectSubmitPlanForAgent(invokingAgent, workflowOptions)) {
            return `Plannotator is configured for plan-agent mode. submit_plan can only be called by: ${workflowOptions.planningAgents.join(", ")}.

Use /plannotator-last or /plannotator-annotate for manual review, or set workflow to all-agents to allow broader submit_plan access.`;
          }

          if (!args.edits || args.edits.length === 0) {
            return "Error: No edits provided. Pass at least one edit with start and content.";
          }

          // Read existing backing file (empty on first call)
          const project = sanitizeTag(path.basename(ctx.directory)) || "_unknown";
          const backingPath = getPlanBackingPath(project);
          const backingDir = path.dirname(backingPath);
          mkdirSync(backingDir, { recursive: true });

          let existingContent = "";
          if (existsSync(backingPath)) {
            existingContent = readFileSync(backingPath, "utf-8");
          }

          // Validate and apply edits
          const existingLines = existingContent ? existingContent.split("\n") : [];

          const validationError = validateEdits(existingLines, args.edits);
          if (validationError) {
            return `Error: ${validationError}`;
          }

          let resultLines: string[];
          try {
            resultLines = applyEdits(existingLines, args.edits);
          } catch (err) {
            return `Error applying edits: ${err instanceof Error ? err.message : String(err)}`;
          }

          const planContent = resultLines.join("\n");
          if (planContent.length > MAX_PLAN_SIZE) {
            return `Error: Plan content exceeds the maximum size of ${MAX_PLAN_SIZE / (1024 * 1024)}MB.`;
          }
          if (!planContent.trim()) {
            return "Error: Plan content is empty after applying edits.";
          }

          // Write backing file
          writeFileSync(backingPath, planContent, "utf-8");

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
            // Clean up backing file after approval
            try { unlinkSync(backingPath); } catch { /* already gone */ }

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
                planFilePath: backingPath,
                doneMsg: result.savedPath ? `Saved to: ${result.savedPath}` : "",
                feedback: result.feedback,
                proceedSuffix: shouldSwitchAgent
                  ? "\n\nProceed with implementation, incorporating these notes where applicable."
                  : "",
              });
            }

            return getPlanApprovedPrompt("opencode", undefined, {
              planFilePath: backingPath,
              doneMsg: result.savedPath ? ` Saved to: ${result.savedPath}` : "",
            });
          } else {
            const lineNumberedPlan = formatWithLineNumbers(planContent);
            const totalLines = planContent.split("\n").length;

            return getPlanDeniedPrompt("opencode", undefined, {
              toolName: getPlanToolName("opencode"),
              planFileRule: "",
              feedback: result.feedback || "Plan changes requested",
            }) + `\n\n## Current Plan (${totalLines} lines)\n\nThe plan below shows the current state with line numbers. Use these exact line numbers in your next \`submit_plan\` call:\n\n\`\`\`\n${lineNumberedPlan}\n\`\`\`\n\nCall \`submit_plan\` with targeted edits to address the feedback above.`;
          }
        },
      }),
    };
  }

  return plugin;
};

export default PlannotatorPlugin;
