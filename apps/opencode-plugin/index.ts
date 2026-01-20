/**
 * Plannotator Plugin for OpenCode
 *
 * Provides a Claude Code-style planning experience with interactive plan review.
 * When the agent calls submit_plan, the Plannotator UI opens for the user to
 * annotate, approve, or request changes to the plan.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (devcontainer, SSH)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
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
import { getGitContext, runGitDiff } from "@plannotator/server/git";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "./review-editor.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

export const PlannotatorPlugin: Plugin = async (ctx) => {
  // Helper to determine if sharing is enabled (lazy evaluation)
  // Priority: OpenCode config > env var > default (enabled)
  async function getSharingEnabled(): Promise<boolean> {
    try {
      const response = await ctx.client.config.get({ query: { directory: ctx.directory } });
      // Config is wrapped in response.data
      // @ts-ignore - share config may exist
      const share = response?.data?.share;
      if (share !== undefined) {
        return share !== "disabled";
      }
    } catch {
      // Config read failed, fall through to env var
    }
    // Fall back to env var
    return process.env.PLANNOTATOR_SHARE !== "disabled";
  }

  return {
    // Register submit_plan as primary-only tool (hidden from sub-agents)
    config: async (opencodeConfig) => {
      const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
      if (!existingPrimaryTools.includes("submit_plan")) {
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, "submit_plan"],
        };
      }
    },

    // Inject planning instructions into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      // Skip for title generation requests
      const existingSystem = output.system.join("\n").toLowerCase();
      if (existingSystem.includes("title generator") || existingSystem.includes("generate a title")) {
        return;
      }

      try {
        // Fetch session messages to determine current agent
        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID }
        });
        const messages = messagesResponse.data;

        // Find last user message (reverse iteration)
        let lastUserAgent: string | undefined;
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

        // Dynamic exclusion: check agent mode via API
        const agentsResponse = await ctx.client.app.agents({
          query: { directory: ctx.directory }
        });
        const agents = agentsResponse.data;
        const agent = agents?.find((a: { name: string }) => a.name === lastUserAgent);

        // Skip if agent is a sub-agent
        // @ts-ignore - Agent has mode field
        if (agent?.mode === "subagent") return;

      } catch {
        // Skip injection on any error (safer)
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

    // Listen for /plannotator-review command
    event: async ({ event }) => {
      // Check for command execution event
      const isCommandEvent =
        event.type === "command.executed" ||
        event.type === "tui.command.execute";

      // @ts-ignore - Event structure: event.properties.name for command.executed
      const commandName = event.properties?.name || event.command || event.payload?.name;
      const isReviewCommand = commandName === "plannotator-review";

      if (isCommandEvent && isReviewCommand) {
        ctx.client.app.log({
          level: "info",
          message: "Opening code review UI...",
        });

        // Get git context (branches, available diff options)
        const gitContext = await getGitContext();

        // Run git diff HEAD (uncommitted changes - default)
        const { patch: rawPatch, label: gitRef } = await runGitDiff(
          "uncommitted",
          gitContext.defaultBranch
        );

        // Start server even if empty - user can switch diff types
        const server = await startReviewServer({
          rawPatch,
          gitRef,
          origin: "opencode",
          diffType: "uncommitted",
          gitContext,
          sharingEnabled: await getSharingEnabled(),
          htmlContent: reviewHtmlContent,
          opencodeClient: ctx.client,
          onReady: handleReviewServerReady,
        });

        const result = await server.waitForDecision();
        await Bun.sleep(1500);
        server.stop();

        // Send feedback back to the session if provided
        if (result.feedback) {
          // @ts-ignore - Event properties contain sessionID for command.executed events
          const sessionId = event.properties?.sessionID;

          // Only try to send feedback if we have a valid session ID
          if (sessionId) {
            // Check agent switch setting (defaults to 'build' if not set)
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            // Send feedback to agent - it will automatically respond and address it
            try {
              await ctx.client.session.prompt({
                path: { id: sessionId },
                body: {
                  ...(shouldSwitchAgent && { agent: targetAgent }),
                  parts: [
                    {
                      type: "text",
                      text: `# Code Review Feedback\n\n${result.feedback}\n\nPlease address this feedback.`,
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
          "Submit your completed plan for interactive user review. The user can annotate, approve, or request changes. Call this when you have finished creating your implementation plan.",
        args: {
          plan: tool.schema
            .string()
            .describe("The complete implementation plan in markdown format"),
          summary: tool.schema
            .string()
            .describe("A brief 1-2 sentence summary of what the plan accomplishes"),
        },

        async execute(args, context) {
          const server = await startPlannotatorServer({
            plan: args.plan,
            origin: "opencode",
            sharingEnabled: await getSharingEnabled(),
            htmlContent,
            opencodeClient: ctx.client,
            onReady: (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
            },
          });

          const result = await server.waitForDecision();
          await Bun.sleep(1500);
          server.stop();

          if (result.approved) {
            // Check agent switch setting (defaults to 'build' if not set)
            const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== 'disabled';
            const targetAgent = result.agentSwitch || 'build';

            if (shouldSwitchAgent) {
              // Switch TUI display to target agent
              try {
                await ctx.client.tui.executeCommand({
                  body: { command: "agent_cycle" },
                });
              } catch {
                // Silently fail
              }

              // Create a user message with target agent using noReply: true
              // This ensures the message is created BEFORE we return from the tool,
              // so the current loop's next iteration will see it.
              // noReply: true means we don't wait for a new loop to complete.
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

            // If user approved with annotations, include them as notes for implementation
            if (result.feedback) {
              return `Plan approved with notes!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}

## Implementation Notes

The user approved your plan but added the following notes to consider during implementation:

${result.feedback}

Proceed with implementation, incorporating these notes where applicable.`;
            }

            return `Plan approved!

Plan Summary: ${args.summary}
${result.savedPath ? `Saved to: ${result.savedPath}` : ""}`;
          } else {
            return `Plan needs revision.
${result.savedPath ? `\nSaved to: ${result.savedPath}` : ""}

The user has requested changes to your plan. Please review their feedback below and revise your plan accordingly.

## User Feedback

${result.feedback}

---

Please revise your plan based on this feedback and call \`submit_plan\` again when ready.`;
          }
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
