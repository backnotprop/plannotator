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
 * - Bash restricted to read-only commands during planning
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
import { isSafeCommand, markCompletedSteps, parseChecklist, type ChecklistItem } from "./utils.js";
import {
  startPlanReviewServer,
  startReviewServer,
  startAnnotateServer,
  getGitContext,
  runGitDiff,
  openBrowser,
} from "./server.js";

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

// Tool sets by phase
const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "exit_plan_mode"];
const EXECUTION_TOOLS = ["read", "bash", "edit", "write"];
const NORMAL_TOOLS = ["read", "bash", "edit", "write"];

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

export default function plannotator(pi: ExtensionAPI): void {
  let phase: Phase = "idle";
  let planFilePath = "PLAN.md";
  let checklistItems: ChecklistItem[] = [];

  // ── Flags ────────────────────────────────────────────────────────────

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
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

  function enterPlanning(ctx: ExtensionContext): void {
    phase = "planning";
    checklistItems = [];
    pi.setActiveTools(PLANNING_TOOLS);
    updateStatus(ctx);
    updateWidget(ctx);
    persistState();
    ctx.ui.notify(`Plannotator: planning mode enabled. Write your plan to ${planFilePath}.`);
  }

  function exitToIdle(ctx: ExtensionContext): void {
    phase = "idle";
    checklistItems = [];
    pi.setActiveTools(NORMAL_TOOLS);
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
    handler: async (_args, ctx) => togglePlanMode(ctx),
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

  pi.registerCommand("plannotator-review", {
    description: "Open interactive code review for current changes",
    handler: async (_args, ctx) => {
      if (!reviewHtmlContent) {
        ctx.ui.notify("Review UI not available. Run 'bun run build' in the pi-extension directory.", "error");
        return;
      }

      ctx.ui.notify("Opening code review UI...", "info");

      const gitCtx = getGitContext();
      const { patch: rawPatch, label: gitRef } = runGitDiff("uncommitted", gitCtx.defaultBranch);

      const server = startReviewServer({
        rawPatch,
        gitRef,
        origin: "pi",
        diffType: "uncommitted",
        gitContext: gitCtx,
        htmlContent: reviewHtmlContent,
      });

      openBrowser(server.url);

      const result = await server.waitForDecision();
      await new Promise((r) => setTimeout(r, 1500));
      server.stop();

      if (result.feedback) {
        pi.sendUserMessage(`# Code Review Feedback\n\n${result.feedback}\n\nPlease address this feedback.`);
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
      const server = startAnnotateServer({
        markdown,
        filePath: absolutePath,
        origin: "pi",
        htmlContent: planHtmlContent,
      });

      openBrowser(server.url);

      const result = await server.waitForDecision();
      await new Promise((r) => setTimeout(r, 1500));
      server.stop();

      if (result.feedback) {
        pi.sendUserMessage(
          `# Markdown Annotations\n\nFile: ${absolutePath}\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
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
      "Request approval to exit plan mode and begin execution. " +
      "Call this after writing your plan to PLAN.md. " +
      "The user will review the plan in a visual browser UI and can approve, deny with feedback, or annotate it.",
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
        pi.setActiveTools(EXECUTION_TOOLS);
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
      const server = startPlanReviewServer({
        plan: planContent,
        htmlContent: planHtmlContent,
        origin: "pi",
      });

      openBrowser(server.url);

      // Wait for user decision in the browser
      const result = await server.waitForDecision();
      await new Promise((r) => setTimeout(r, 1500));
      server.stop();

      if (result.approved) {
        phase = "executing";
        pi.setActiveTools(EXECUTION_TOOLS);
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
            text: `Plan not approved.\n\nUser feedback: ${feedbackText}\n\nPlease revise ${planFilePath} and call exit_plan_mode again when ready.`,
          },
        ],
        details: { approved: false, feedback: feedbackText },
      };
    },
  });

  // ── Event Handlers ───────────────────────────────────────────────────

  // Gate writes and bash during planning
  pi.on("tool_call", async (event, ctx) => {
    if (phase !== "planning") return;

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plannotator: command blocked (not in read-only allowlist).\nCommand: ${command}`,
        };
      }
    }

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
      return {
        block: true,
        reason: "Plannotator: edit is not available during planning. Use write to update your plan file.",
      };
    }
  });

  // Inject phase-specific context
  pi.on("before_agent_start", async (_event, ctx) => {
    if (phase === "planning") {
      return {
        message: {
          customType: "plannotator-context",
          content: `[PLANNOTATOR - PLANNING PHASE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Available tools: read, bash (read-only commands only), grep, find, ls, write (${planFilePath} only), exit_plan_mode
Restricted: edit is disabled, write only works for ${planFilePath}, bash only allows read-only commands.

Workflow:
1. Explore the codebase thoroughly using read, grep, find, ls, and bash.
2. Write your plan to ${planFilePath} using markdown checklist format:
   - [ ] Step 1 description
   - [ ] Step 2 description
   ...
3. When your plan is complete, call exit_plan_mode to request approval.
4. If denied, revise ${planFilePath} based on the feedback and call exit_plan_mode again.

Do NOT attempt to modify source files. Focus only on exploration and planning.`,
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
      pi.setActiveTools(NORMAL_TOOLS);
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
      pi.setActiveTools(PLANNING_TOOLS);
    } else if (phase === "executing") {
      pi.setActiveTools(EXECUTION_TOOLS);
    }

    updateStatus(ctx);
    updateWidget(ctx);
  });
}
