/**
 * Plannotator Plugin for OpenCode
 *
 * Provides a Claude Code-style planning experience with interactive plan review.
 * When the agent calls submit_plan, the Plannotator UI opens for the user to
 * annotate, approve, or request changes to the plan.
 *
 * @packageDocumentation
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { $ } from "bun";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

interface ServerResult {
  port: number;
  url: string;
  waitForDecision: () => Promise<{ approved: boolean; feedback?: string }>;
  stop: () => void;
}

async function startPlannotatorServer(planContent: string): Promise<ServerResult> {
  let resolveDecision: (result: { approved: boolean; feedback?: string }) => void;
  const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>(
    (resolve) => { resolveDecision = resolve; }
  );

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/plan") {
        return Response.json({ plan: planContent });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        resolveDecision({ approved: true });
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/deny" && req.method === "POST") {
        try {
          const body = await req.json() as { feedback?: string };
          resolveDecision({ approved: false, feedback: body.feedback || "Plan rejected by user" });
        } catch {
          resolveDecision({ approved: false, feedback: "Plan rejected by user" });
        }
        return Response.json({ ok: true });
      }

      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html" }
      });
    },
  });

  return {
    port: server.port!,
    url: `http://localhost:${server.port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.stop(),
  };
}

async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      await $`cmd /c start ${url}`.quiet();
    } else if (process.platform === "darwin") {
      await $`open ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
  } catch {
    // Silently fail - user can open manually if needed
  }
}

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

        async execute(args, _context) {
          const server = await startPlannotatorServer(args.plan);
          await openBrowser(server.url);

          const result = await server.waitForDecision();
          await Bun.sleep(1500);
          server.stop();

          if (result.approved) {
            try {
              await ctx.client.tui.executeCommand({
                body: { command: "agent_cycle" },
              });
            } catch {
              // Silently fail - agent switching is optional
            }

            return `Plan approved! Switching to build mode.

Your plan has been approved by the user. You may now proceed with implementation.

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
