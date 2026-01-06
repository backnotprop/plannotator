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

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

export const PlannotatorPlugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
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
            htmlContent,
            onReady: (url, isRemote, port) => {
              handleServerReady(url, isRemote, port);
            },
          });

          const result = await server.waitForDecision();
          await Bun.sleep(1500);
          server.stop();

          if (result.approved) {
            // Switch TUI display to build agent
            try {
              await ctx.client.tui.executeCommand({
                body: { command: "agent_cycle" },
              });
            } catch {
              // Silently fail
            }

            // Send a new message with build agent - fire and forget (don't await)
            // Awaiting can cause the message to be queued instead of processed
            ctx.client.session.prompt({
              path: { id: context.sessionID },
              body: {
                agent: "build",
                parts: [{ type: "text", text: "Proceed with implementation" }],
              },
            }).catch(() => {});

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
        },
      }),
    },
  };
};

export default PlannotatorPlugin;
