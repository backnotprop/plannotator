/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * Plans are written to PLAN.md on disk (git-trackable, editor-visible).
 * The agent calls exit_plan_mode to request approval; the user reviews
 * the plan in the Plannotator browser UI and can approve, deny with
 * annotations, or request changes.
 *
 * Features:
 * - /plannotator command or Ctrl+Alt+P to toggle
 * - --plan flag to start in planning mode
 * - --plan-file flag to customize the plan file path
 * - Bash unrestricted during planning (prompt-guided)
 * - Write restricted to plan file only during planning
 * - exit_plan_mode tool with browser-based visual approval
 * - [DONE:n] markers for execution progress tracking
 * - /plannotator-review command for code review
 * - /plannotator-annotate command for markdown annotation
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { markCompletedSteps, parseChecklist, type ChecklistItem } from "./utils.js";
import {
  type AnnotateServerResult,
  startPlanReviewServer,
  type PlanServerResult,
  startReviewServer,
  type ReviewServerResult,
  startAnnotateServer,
  getGitContext,
  runGitDiff,
  openBrowser,
} from "./server.js";
import { planDenyFeedback } from "./feedback-templates.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Common interface for servers that can wait for a user decision in a browser. */
interface DecisionServer<T> {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<T>;
}

// Load HTML at runtime (jiti doesn't support import attributes)
const __dirname = dirname(fileURLToPath(import.meta.url));
let planHtmlContent = "";
let reviewHtmlContent = "";
try {
  planHtmlContent = readFileSync(resolve(__dirname, "plannotator.html"), "utf-8");
} catch {
  // HTML not built yet — browser features will be unavailable
}
try {
  reviewHtmlContent = readFileSync(resolve(__dirname, "review-editor.html"), "utf-8");
} catch {
  // HTML not built yet — review feature will be unavailable
}

/** Extra tools to ensure are available during planning (on top of whatever is already active). */
const PLANNING_EXTRA_TOOLS = ["grep", "find", "ls", "exit_plan_mode"];

type Phase = "idle" | "planning" | "executing";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Open browser for user review, wait for decision, then stop server.
 * Handles remote session notification automatically.
 */
async function runBrowserReview<T>(
  server: DecisionServer<T>,
  ctx: ExtensionContext,
): Promise<T> {
  const browserResult = openBrowser(server.url);
  if (browserResult.isRemote) {
    ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, "info");
  }

  const result = await server.waitForDecision();
  await new Promise((r) => setTimeout(r, 1500));
  server.stop();
  return result;
}

function getStartupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export default function plannotator(pi: ExtensionAPI): void {
  let phase: Phase = "idle";
  let planFilePath = "PLAN.md";
  let checklistItems: ChecklistItem[] = [];
  let preplanTools: string[] | null = null;

  // ── Flags ────────────────────────────────────────────────────────────

  pi.registerFlag("plan", {
    description: "Start in plan mode (restricted exploration and planning)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("plan-file", {
    description: "Plan file path (default: PLAN.md)",
    type: "string",
    default: "PLAN.md",
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  function resolvePlanPath(cwd: string): string {
    return resolve(cwd, planFilePath);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (phase === "executing" && checklistItems.length > 0) {
      const completed = checklistItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", `📋 ${completed}/${checklistItems.length}`));
    } else if (phase === "planning") {
      ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plannotator", undefined);
    }
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (phase === "executing" && checklistItems.length > 0) {
      const lines = checklistItems.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("plannotator-progress", lines);
    } else {
      ctx.ui.setWidget("plannotator-progress", undefined);
    }
  }

  function persistState(): void {
    pi.appendEntry("plannotator", { phase, planFilePath });
  }

  /** Apply tool visibility for the current phase, preserving tools from other extensions. */
  function applyToolsForPhase(): void {
    if (phase === "planning") {
      const base = preplanTools ?? pi.getActiveTools();
      const toolSet = new Set(base);
      for (const t of PLANNING_EXTRA_TOOLS) toolSet.add(t);
      pi.setActiveTools([...toolSet]);
    } else if (preplanTools) {
      // Restore pre-plan tool set (removes exit_plan_mode, etc.)
      pi.setActiveTools(preplanTools);
      preplanTools = null;
    }
    // If no preplanTools (e.g. session restore to executing/idle), leave tools as-is
  }

  function enterPlanning(ctx: ExtensionContext): void {
    phase = "planning";
    checklistItems = [];
    preplanTools = pi.getActiveTools();
    applyToolsForPhase();
    updateStatus(ctx);
    updateWidget(ctx);
    persistState();
    ctx.ui.notify(`Plannotator: planning mode enabled. Write your plan to ${planFilePath}.`);
  }

  function exitToIdle(ctx: ExtensionContext): void {
    phase = "idle";
    checklistItems = [];
    applyToolsForPhase();
    updateStatus(ctx);
    updateWidget(ctx);
    persistState();
    ctx.ui.notify("Plannotator: disabled. Full access restored.");
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (phase === "idle") {
      enterPlanning(ctx);
    } else {
      exitToIdle(ctx);
    }
  }

  // ── Commands & Shortcuts ─────────────────────────────────────────────

  pi.registerCommand("plannotator", {
    description: "Toggle plannotator (file-based plan mode)",
    handler: async (args, ctx) => {
      if (phase !== "idle") {
        exitToIdle(ctx);
        return;
      }

      // Accept path as argument: /plannotator plans/auth.md
      let targetPath = args?.trim() || undefined;

      // No arg — prompt for file path interactively
      if (!targetPath && ctx.hasUI) {
        targetPath = await ctx.ui.input("Plan file path", planFilePath);
        if (targetPath === undefined) return; // cancelled
      }

      if (targetPath) planFilePath = targetPath;
      enterPlanning(ctx);
    },
  });

  pi.registerCommand("plannotator-status", {
    description: "Show plannotator status",
    handler: async (_args, ctx) => {
      const parts = [`Phase: ${phase}`, `Plan file: ${planFilePath}`];
      if (checklistItems.length > 0) {
        const done = checklistItems.filter((t) => t.completed).length;
        parts.push(`Progress: ${done}/${checklistItems.length}`);
      }
      ctx.ui.notify(parts.join("\n"), "info");
    },
  });

  pi.registerCommand("plannotator-set-file", {
    description: "Change the plan file path",
    handler: async (args, ctx) => {
      let targetPath = args?.trim() || undefined;

      if (!targetPath && ctx.hasUI) {
        targetPath = await ctx.ui.input("Plan file path", planFilePath);
        if (targetPath === undefined) return; // cancelled
      }

      if (!targetPath) {
        ctx.ui.notify(`Current plan file: ${planFilePath}`, "info");
        return;
      }

      planFilePath = targetPath;
      persistState();
      ctx.ui.notify(`Plan file changed to: ${planFilePath}`);
    },
  });

  pi.registerCommand("plannotator-review", {
    description: "Open interactive code review for current changes",
    handler: async (_args, ctx) => {
      if (!reviewHtmlContent) {
        ctx.ui.notify("Review UI not available. Run 'bun run build' in the pi-extension directory.", "error");
        return;
      }

      ctx.ui.notify("Opening code review UI...", "info");

      let server: ReviewServerResult;
      try {
        const gitCtx = await getGitContext();
        const {
          patch: rawPatch,
          label: gitRef,
          error,
        } = await runGitDiff("uncommitted", gitCtx.defaultBranch);

        server = await startReviewServer({
          rawPatch,
          gitRef,
          error,
          origin: "pi",
          diffType: "uncommitted",
          gitContext: gitCtx,
          htmlContent: reviewHtmlContent,
          sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
          shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
          pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start code review UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserReview(server, ctx);

      if (result.feedback) {
        if (result.approved) {
          pi.sendUserMessage(`# Code Review\n\nCode review completed — no changes requested.`);
        } else {
          pi.sendUserMessage(`${result.feedback}\n\nPlease address this feedback.`);
        }
      } else {
        ctx.ui.notify("Code review closed (no feedback).", "info");
      }
    },
  });

  pi.registerCommand("plannotator-annotate", {
    description: "Open markdown file in annotation UI",
    handler: async (args, ctx) => {
      const filePath = args?.trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /plannotator-annotate <file.md>", "error");
        return;
      }
      if (!planHtmlContent) {
        ctx.ui.notify("Annotation UI not available. Run 'bun run build' in the pi-extension directory.", "error");
        return;
      }

      const absolutePath = resolve(ctx.cwd, filePath);
      if (!existsSync(absolutePath)) {
        ctx.ui.notify(`File not found: ${absolutePath}`, "error");
        return;
      }

      ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");

      const markdown = readFileSync(absolutePath, "utf-8");
      let server: AnnotateServerResult;
      try {
        server = await startAnnotateServer({
          markdown,
          filePath: absolutePath,
          origin: "pi",
          htmlContent: planHtmlContent,
          sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
          shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
          pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserReview(server, ctx);

      if (result.feedback) {
        pi.sendUserMessage(
          `# Markdown Annotations\n\nFile: ${absolutePath}\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
        );
      } else {
        ctx.ui.notify("Annotation closed (no feedback).", "info");
      }
    },
  });

  pi.registerCommand("plannotator-last", {
    description: "Annotate the last assistant message",
    handler: async (args, ctx) => {
      if (!planHtmlContent) {
        ctx.ui.notify("Annotation UI not available. Run 'bun run build' in the pi-extension directory.", "error");
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      let lastText: string | null = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; message?: AgentMessage };
        if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
          const text = getTextContent(entry.message);
          if (text.trim()) {
            lastText = text;
            break;
          }
        }
      }

      if (!lastText) {
        ctx.ui.notify("No assistant message found in session.", "error");
        return;
      }

      ctx.ui.notify("Opening annotation UI for last message...", "info");

      let server: AnnotateServerResult;
      try {
        server = await startAnnotateServer({
          markdown: lastText,
          filePath: "last-message",
          origin: "pi",
          mode: "annotate-last",
          htmlContent: planHtmlContent,
          sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
          shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
          pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserReview(server, ctx);

      if (result.feedback) {
        pi.sendUserMessage(
          `# Message Annotations\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
        );
      } else {
        ctx.ui.notify("Annotation closed (no feedback).", "info");
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plannotator",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // ── exit_plan_mode Tool ──────────────────────────────────────────────

  pi.registerTool({
    name: "exit_plan_mode",
    label: "Exit Plan Mode",
    description:
      "Submit your plan for user review. " +
      "Call this after drafting or revising your plan file. " +
      "The user will review the plan in a visual browser UI and can approve, deny with feedback, or annotate it. " +
      "If denied, use the edit tool to make targeted revisions (not write), then call this again.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({ description: "Brief summary of the plan for the user's review" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Guard: must be in planning phase
      if (phase !== "planning") {
        return {
          content: [{ type: "text", text: "Error: Not in plan mode. Use /plannotator to enter planning mode first." }],
          details: { approved: false },
        };
      }

      // Read plan file
      const fullPath = resolvePlanPath(ctx.cwd);
      let planContent: string;
      try {
        planContent = readFileSync(fullPath, "utf-8");
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${planFilePath} does not exist. Write your plan using the write tool first, then call exit_plan_mode again.`,
            },
          ],
          details: { approved: false },
        };
      }

      if (planContent.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${planFilePath} is empty. Write your plan first, then call exit_plan_mode again.`,
            },
          ],
          details: { approved: false },
        };
      }

      // Parse checklist items
      checklistItems = parseChecklist(planContent);

      // Non-interactive or no HTML: auto-approve
      if (!ctx.hasUI || !planHtmlContent) {
        phase = "executing";
        applyToolsForPhase();
        persistState();
        return {
          content: [
            {
              type: "text",
              text: "Plan auto-approved (non-interactive mode). Execute the plan now.",
            },
          ],
          details: { approved: true },
        };
      }

      // Start browser-based plan review server
      let server: PlanServerResult;
      try {
        server = await startPlanReviewServer({
          plan: planContent,
          htmlContent: planHtmlContent,
          origin: "pi",
          sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
          shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
          pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
        });
      } catch (err) {
        const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
        ctx.ui.notify(message, "error");
        return {
          content: [{ type: "text", text: message }],
          details: { approved: false },
        };
      }

      const result = await runBrowserReview(server, ctx);

      if (result.approved) {
        phase = "executing";
        applyToolsForPhase();
        updateStatus(ctx);
        updateWidget(ctx);
        persistState();

        pi.appendEntry("plannotator-execute", { planFilePath });

        const doneMsg = checklistItems.length > 0
          ? `After completing each step, include [DONE:n] in your response where n is the step number.`
          : "";

        if (result.feedback) {
          return {
            content: [
              {
                type: "text",
                text: `Plan approved with notes! You now have full tool access (read, bash, edit, write). Execute the plan in ${planFilePath}. ${doneMsg}\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n${result.feedback}\n\nProceed with implementation, incorporating these notes where applicable.`,
              },
            ],
            details: { approved: true, feedback: result.feedback },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Plan approved. You now have full tool access (read, bash, edit, write). Execute the plan in ${planFilePath}. ${doneMsg}`,
            },
          ],
          details: { approved: true },
        };
      }

      // Denied
      const feedbackText = result.feedback || "Plan rejected. Please revise.";
      return {
        content: [
          {
            type: "text",
            text: planDenyFeedback(feedbackText, "exit_plan_mode", { planFilePath }),
          },
        ],
        details: { approved: false, feedback: feedbackText },
      };
    },
  });

  // ── Event Handlers ───────────────────────────────────────────────────

  // Gate writes during planning
  pi.on("tool_call", async (event, ctx) => {
    if (phase !== "planning") return;

    if (event.toolName === "write") {
      const targetPath = resolve(ctx.cwd, event.input.path as string);
      const allowedPath = resolvePlanPath(ctx.cwd);
      if (targetPath !== allowedPath) {
        return {
          block: true,
          reason: `Plannotator: writes are restricted to ${planFilePath} during planning. Blocked: ${event.input.path}`,
        };
      }
    }

    if (event.toolName === "edit") {
      const targetPath = resolve(ctx.cwd, event.input.path as string);
      const allowedPath = resolvePlanPath(ctx.cwd);
      if (targetPath !== allowedPath) {
        return {
          block: true,
          reason: `Plannotator: edits are restricted to ${planFilePath} during planning. Blocked: ${event.input.path}`,
        };
      }
    }
  });

  // Inject phase-specific context
  pi.on("before_agent_start", async (_event, ctx) => {
    if (phase === "planning") {
      return {
        message: {
          customType: "plannotator-context",
          content: `[PLANNOTATOR - PLANNING PHASE]
You are in plan mode. You MUST NOT make any changes to the codebase — no edits, no commits, no installs, no destructive commands. The ONLY file you may write to or edit is the plan file: ${planFilePath}.

Available tools: read, bash, grep, find, ls, write (${planFilePath} only), edit (${planFilePath} only), exit_plan_mode

Do not run destructive bash commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Web fetching (curl, wget) is fine.

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, then write your findings into ${planFilePath} as you go. The plan starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read, grep, find, ls, and bash to understand the codebase. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.
2. **Update the plan file** — After each discovery, immediately capture what you learned in ${planFilePath}. Don't wait until the end. Use write for the initial draft, then edit for all subsequent updates.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, ask. Then go back to step 1.

### First Turn

Start by quickly scanning key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code.
- Batch related questions together.
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge-case priorities.
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none.

### Plan File Structure

Your plan file should use markdown with clear sections:
- **Context** — Why this change is being made: the problem, what prompted it, the intended outcome.
- **Approach** — Your recommended approach only, not all alternatives considered.
- **Files to modify** — List the critical file paths that will be changed.
- **Reuse** — Reference existing functions and utilities you found, with their file paths.
- **Steps** — Implementation checklist:
  - [ ] Step 1 description
  - [ ] Step 2 description
- **Verification** — How to test the changes end-to-end (run the code, run tests, manual checks).

Keep the plan concise enough to scan quickly, but detailed enough to execute effectively.

### When to Submit

Your plan is ready when you've addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse, and how to verify. Call exit_plan_mode to submit for review.

### Revising After Feedback

When the user denies a plan with feedback:
1. Read ${planFilePath} to see the current plan.
2. Use the edit tool to make targeted changes addressing the feedback — do NOT rewrite the entire file.
3. Call exit_plan_mode again to resubmit.

### Ending Your Turn

Your turn should only end by either:
- Asking the user a question to gather more information.
- Calling exit_plan_mode when the plan is ready for review.

Do not end your turn without doing one of these two things.`,
          display: false,
        },
      };
    }

    if (phase === "executing" && checklistItems.length > 0) {
      // Re-read from disk each turn to stay current
      const fullPath = resolvePlanPath(ctx.cwd);
      let planContent = "";
      try {
        planContent = readFileSync(fullPath, "utf-8");
        checklistItems = parseChecklist(planContent);
      } catch {
        // File deleted during execution — degrade gracefully
      }

      const remaining = checklistItems.filter((t) => !t.completed);
      if (remaining.length > 0) {
        const todoList = remaining.map((t) => `- [ ] ${t.step}. ${t.text}`).join("\n");
        return {
          message: {
            customType: "plannotator-context",
            content: `[PLANNOTATOR - EXECUTING PLAN]
Full tool access is enabled. Execute the plan from ${planFilePath}.

Remaining steps:
${todoList}

Execute each step in order. After completing a step, include [DONE:n] in your response where n is the step number.`,
            display: false,
          },
        };
      }
    }
  });

  // Filter stale context when idle
  pi.on("context", async (event) => {
    if (phase !== "idle") return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plannotator-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLANNOTATOR -");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) => c.type === "text" && (c as TextContent).text?.includes("[PLANNOTATOR -"),
          );
        }
        return true;
      }),
    };
  });

  // Track execution progress
  pi.on("turn_end", async (event, ctx) => {
    if (phase !== "executing" || checklistItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, checklistItems) > 0) {
      updateStatus(ctx);
      updateWidget(ctx);
    }
    persistState();
  });

  // Detect execution completion
  pi.on("agent_end", async (_event, ctx) => {
    if (phase !== "executing" || checklistItems.length === 0) return;

    if (checklistItems.every((t) => t.completed)) {
      const completedList = checklistItems.map((t) => `- [x] ~~${t.text}~~`).join("\n");
      pi.sendMessage(
        {
          customType: "plannotator-complete",
          content: `**Plan Complete!** ✓\n\n${completedList}`,
          display: true,
        },
        { triggerTurn: false },
      );
      phase = "idle";
      checklistItems = [];
      applyToolsForPhase();
      updateStatus(ctx);
      updateWidget(ctx);
      persistState();
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    // Resolve plan file path from flag
    const flagPlanFile = pi.getFlag("plan-file") as string;
    if (flagPlanFile) {
      planFilePath = flagPlanFile;
    }

    // Check --plan flag
    if (pi.getFlag("plan") === true) {
      phase = "planning";
    }

    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plannotator")
      .pop() as { data?: { phase: Phase; planFilePath?: string } } | undefined;

    if (stateEntry?.data) {
      phase = stateEntry.data.phase ?? phase;
      planFilePath = stateEntry.data.planFilePath ?? planFilePath;
    }

    // Rebuild execution state from disk + session messages
    if (phase === "executing") {
      const fullPath = resolvePlanPath(ctx.cwd);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        checklistItems = parseChecklist(content);

        // Find last execution marker and scan messages after it for [DONE:n]
        let executeIndex = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i] as { type: string; customType?: string };
          if (entry.customType === "plannotator-execute") {
            executeIndex = i;
            break;
          }
        }

        for (let i = executeIndex + 1; i < entries.length; i++) {
          const entry = entries[i];
          if (
            entry.type === "message" &&
            "message" in entry &&
            isAssistantMessage(entry.message as AgentMessage)
          ) {
            const text = getTextContent(entry.message as AssistantMessage);
            markCompletedSteps(text, checklistItems);
          }
        }
      } else {
        // Plan file gone — fall back to idle
        phase = "idle";
      }
    }

    // Apply tool restrictions for current phase
    if (phase === "planning") {
      applyToolsForPhase();
    }

    updateStatus(ctx);
    updateWidget(ctx);
  });
}
