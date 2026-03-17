/**
 * Plannotator Plugin for OpenCode
 *
 * Provides iterative planning with interactive browser-based plan review.
 *
 * When the agent is in plan mode:
 * - Injects planning prompt directing the agent to write plans in $XDG_DATA_HOME/opencode/plans/
 * - Agent creates a uniquely-named plan file, revises it on feedback
 * - submit_plan(path) reads the plan from disk and opens browser UI
 * - plan_exit suppressed in favor of submit_plan (experimental mode compatibility)
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (devcontainer, SSH)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_PLAN_TIMEOUT_SECONDS - Max wait for submit_plan approval (default: 345600, set 0 to disable)
 *   PLANNOTATOR_ALLOW_SUBAGENTS - Set to "1" to allow subagents to see submit_plan tool
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
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
import { getGitContext, runGitDiffWithContext } from "@plannotator/server/git";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";
import { planDenyFeedback } from "@plannotator/shared/feedback-templates";
import {
  getPlanDirectory,
  validatePlanPath,
  stripConflictingPlanModeRules,
} from "./plan-mode";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "./review-editor.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600; // 96 hours

// ── Planning prompt ───────────────────────────────────────────────────────

function getPlanningPrompt(planDir: string): string {
  return `## Plannotator — Iterative Planning

Your plan files must live in this directory:

${planDir}

You must not edit the codebase during planning. The only files you may create or edit are plan markdown files inside that directory. Do not run destructive shell commands (rm, git push, npm install, etc.).

### Step 1 — Explore

Before writing anything, understand the task and the code it touches.

- Read the relevant source files. Trace call paths, data flow, and dependencies.
- Look at existing patterns, utilities, and conventions in the codebase — your plan should reuse them.
- Check related tests to understand expected behavior and edge cases.
- Scale depth to the task: a vague feature request needs deep exploration; a focused bug fix may only need a few files.

Do not jump to writing a plan or asking questions until you have the context you need. If the conversation already provided sufficient context, or the task is greenfield with no code to explore, move on to the next step.

### Step 2 — Ask (if needed)

If there are things only the user can answer — requirements, preferences, tradeoffs, edge-case priorities — use the \`question\` tool. Do not ask via plain text output.

- Never ask what you could find out by reading the code.
- Batch related questions into a single \`question\` call.
- For greenfield tasks, this may be your first step.

### Step 3 — Write the plan

Once you understand the task, create exactly one markdown plan file in the directory above with a unique, descriptive filename (e.g. \`auth-refactor.md\`, \`fix-upload-timeout.md\`). Do not overwrite or reuse filenames from existing plans.

Structure the plan with:
- **Context** — Why this change is being made.
- **Approach** — Your recommended approach only, not all alternatives considered.
- **Files to modify** — List the critical file paths that will be changed.
- **Reuse** — Reference existing functions and utilities you found, with their file paths.
- **Steps** — Implementation checklist with \`- [ ]\` items.
- **Verification** — How to test the changes end-to-end.

Keep it concise enough to scan quickly, but detailed enough to execute effectively.

### Step 4 — Submit

Call \`submit_plan(path: "/absolute/path/to/your-plan.md")\` to open the plan in a visual review UI. Do not submit plan text directly — submit the file path.

### If the user requests changes

1. Read the same plan file you previously submitted.
2. Edit that same file to address the feedback.
3. Call \`submit_plan\` again with the same \`path\`.
4. Never create a new file in response to feedback — always revise the existing one.

### Ending your turn

Your turn should only end by either:
- Using the question tool to ask the user for information.
- Calling submit_plan when the plan is ready for review.

Do not end your turn without doing one of these two things.`;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export const PlannotatorPlugin: Plugin = async (ctx) => {
  // Agents list is static for the session lifetime — fetch once and cache
  let cachedAgents: any[] | null = null;

  // Helper to determine if sharing is enabled (lazy evaluation)
  // Priority: OpenCode config > env var > default (enabled)
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

  return {
    // Register submit_plan as primary-only tool (hidden from sub-agents by default)
    config: async (opencodeConfig) => {
      if (allowSubagents()) return;

      const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
      if (!existingPrimaryTools.includes("submit_plan")) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, "submit_plan"],
        };
      }
    },

    // Suppress plan_exit in favor of submit_plan
    "tool.definition": async (input, output) => {
      if (input.toolID === "plan_exit") {
        output.description =
          "Do not call this tool. Use submit_plan instead — it opens a visual review UI for plan approval.";
      }
    },

    // Inject planning instructions into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      // Skip for title generation requests
      const systemText = output.system.join("\n");
      if (systemText.toLowerCase().includes("title generator") || systemText.toLowerCase().includes("generate a title")) {
        return;
      }

      let lastUserAgent: string | undefined;
      try {
        // Fetch session messages to determine current agent
        const messagesResponse = await ctx.client.session.messages({
          // @ts-ignore - sessionID exists on input
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;

        // Find last user message (reverse iteration)
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.info.role === "user") {
              // @ts-ignore - UserMessage has agent field
              lastUserAgent = msg.info.agent;
              break;
            }
          }
        }

        // Skip if agent detection fails (safer)
        if (!lastUserAgent) return;

        // Hardcoded exclusion: build agent
        if (lastUserAgent === "build") return;

        // Agents list is static — cache after first fetch
        if (!cachedAgents) {
          const agentsResponse = await ctx.client.app.agents({
            query: { directory: ctx.directory }
          });
          cachedAgents = agentsResponse.data ?? [];
        }
        const agent = cachedAgents.find((a: { name: string }) => a.name === lastUserAgent);

        // Skip if agent is a sub-agent
        // @ts-ignore - Agent has mode field
        if (agent?.mode === "subagent") return;

      } catch {
        // Skip injection on any error (safer)
        return;
      }

      // Plan agent: inject full iterative planning prompt
      if (lastUserAgent === "plan") {
        const planDir = getPlanDirectory();
        output.system = stripConflictingPlanModeRules(output.system);
        output.system.push(getPlanningPrompt(planDir));
        return;
      }

      // Other primary agents: inject minimal submission reminder
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

    // Listen for slash commands
    event: async ({ event }) => {
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      // @ts-ignore - Event structure varies
      const commandName = event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";

      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({
          level: "info",
          message: "Opening code review UI...",
        });

        const cwd = ctx.directory;
        const gitContext = await getGitContext(cwd);
        const { patch: rawPatch, label: gitRef, error: diffError } = await runGitDiffWithContext(
          "uncommitted",
          gitContext
        );

        const server = await startReviewServer({
          rawPatch,
          gitRef,
          error: diffError,
          origin: "opencode",
          diffType: "uncommitted",
          gitContext,
          sharingEnabled: await getSharingEnabled(),
          shareBaseUrl: getShareBaseUrl(),
          htmlContent: reviewHtmlContent,
          opencodeClient: ctx.client,
          onReady: handleReviewServerReady,
        });

        const result = await server.waitForDecision();
        await Bun.sleep(1500);
        server.stop();

        if (result.feedback) {
          // @ts-ignore - Event properties contain sessionID
          const sessionId = event.properties?.sessionID;

          if (sessionId) {
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            const message = result.approved
              ? `# Code Review\n\nCode review completed — no changes requested.`
              : `# Code Review Feedback\n\n${result.feedback}\n\nPlease address this feedback.`;

            try {
              await ctx.client.session.prompt({
                path: { id: sessionId },
                body: {
                  ...(shouldSwitchAgent && { agent: targetAgent }),
                  parts: [{ type: "text", text: message }],
                },
              });
            } catch {
              // Session may not be available
            }
          }
        }
      }

      // Handle /plannotator-annotate command
      const isAnnotateCommand = commandName === "plannotator-annotate";

      if (isCommandEvent && isAnnotateCommand) {
        // @ts-ignore - Event properties contain arguments
        const filePath = event.properties?.arguments || event.arguments || "";

        if (!filePath) {
          ctx.client.app.log({
            level: "error",
            message: "Usage: /plannotator-annotate <file.md>",
          });
          return;
        }

        ctx.client.app.log({
          level: "info",
          message: `Opening annotation UI for ${filePath}...`,
        });

        const projectRoot = process.cwd();
        const resolved = await resolveMarkdownFile(filePath, projectRoot);

        if (resolved.kind === "ambiguous") {
          ctx.client.app.log({
            level: "error",
            message: `Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:\n${resolved.matches.map((m) => `  ${m}`).join("\n")}`,
          });
          return;
        }
        if (resolved.kind === "not_found") {
          ctx.client.app.log({
            level: "error",
            message: `File not found: ${resolved.input}`,
          });
          return;
        }

        const absolutePath = resolved.path;
        ctx.client.app.log({
          level: "info",
          message: `Resolved: ${absolutePath}`,
        });
        const markdown = await Bun.file(absolutePath).text();

        const server = await startAnnotateServer({
          markdown,
          filePath: absolutePath,
          origin: "opencode",
          sharingEnabled: await getSharingEnabled(),
          shareBaseUrl: getShareBaseUrl(),
          htmlContent: htmlContent,
          onReady: handleAnnotateServerReady,
        });

        const result = await server.waitForDecision();
        await Bun.sleep(1500);
        server.stop();

        if (result.feedback) {
          // @ts-ignore - Event properties contain sessionID
          const sessionId = event.properties?.sessionID;

          if (sessionId) {
            try {
              await ctx.client.session.prompt({
                path: { id: sessionId },
                body: {
                  parts: [
                    {
                      type: "text",
                      text: `# Markdown Annotations\n\nFile: ${absolutePath}\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
                    },
                  ],
                },
              });
            } catch {
              // Session may not be available
            }
          }
        }
      }
    },

    tool: {
      submit_plan: tool({
        description:
          "Submit your plan file for interactive user review. The user can annotate, approve, or request changes in a visual browser UI. Pass the absolute path to your plan file.",
        args: {
          path: tool.schema
            .string()
            .describe("Absolute path to the plan markdown file on disk."),
        },

        async execute(args, context) {
          const planDir = getPlanDirectory();
          const validation = validatePlanPath(args.path, planDir);

          if (!validation.ok) {
            return `Error: ${validation.error}`;
          }

          const planContent = validation.content;
          const sharingEnabled = await getSharingEnabled();
          const server = await startPlannotatorServer({
            plan: planContent,
            origin: "opencode",
            sharingEnabled,
            shareBaseUrl: getShareBaseUrl(),
            htmlContent,
            opencodeClient: ctx.client,
            onReady: async (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
              if (isRemote && sharingEnabled) {
                await writeRemoteShareLink(planContent, getShareBaseUrl(), "review the plan", "plan only").catch(() => {});
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
            // Check agent switch setting
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            if (shouldSwitchAgent) {
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" },
                });
              } catch {
                // Silently fail
              }

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
              return `Plan approved with notes!
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }

            return `Plan approved!${result.savedPath ? ` Saved to: ${result.savedPath}` : ""}`;
          } else {
            return planDenyFeedback(result.feedback || "", "submit_plan", { planFilePath: args.path });
          }
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
