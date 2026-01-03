/**
 * Plannotator MCP Server
 *
 * A Model Context Protocol (MCP) server for interactive plan review.
 * Works with any MCP-compatible AI coding agent including:
 * - Cursor
 * - GitHub Copilot
 * - Windsurf
 * - Cline
 * - RooCode
 * - KiloCode
 * - Google Antigravity
 * - And more...
 *
 * When the agent calls submit_plan, the Plannotator UI opens for the user to
 * annotate, approve, or request changes to the plan.
 *
 * Usage:
 *   Add to your MCP configuration and run as MCP server:
 *   bunx @plannotator/mcp --mcp
 *
 * @packageDocumentation
 */

import { $ } from "bun";

// @ts-ignore - Bun import attribute for text
import indexHtml from "./plannotator.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

// --- Types ---

interface ServerResult {
    port: number;
    url: string;
    waitForDecision: () => Promise<{ approved: boolean; feedback?: string }>;
    stop: () => void;
}

// --- Plannotator Server ---

/**
 * Start a Plannotator server instance to review a plan
 */
async function startPlannotatorServer(planContent: string): Promise<ServerResult> {
    let resolveDecision: (result: { approved: boolean; feedback?: string }) => void;
    const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>(
        (resolve) => { resolveDecision = resolve; }
    );

    // Use configured port or random
    const port = process.env.PLANNOTATOR_PORT ? parseInt(process.env.PLANNOTATOR_PORT, 10) : 0;

    const server = Bun.serve({
        port,
        async fetch(req: Request) {
            const url = new URL(req.url);

            // API: Get plan content
            if (url.pathname === "/api/plan") {
                return Response.json({ plan: planContent });
            }

            // API: Approve plan
            if (url.pathname === "/api/approve" && req.method === "POST") {
                resolveDecision({ approved: true });
                return Response.json({ ok: true });
            }

            // API: Deny with feedback
            if (url.pathname === "/api/deny" && req.method === "POST") {
                try {
                    const body = await req.json() as { feedback?: string };
                    resolveDecision({ approved: false, feedback: body.feedback || "Plan rejected by user" });
                } catch {
                    resolveDecision({ approved: false, feedback: "Plan rejected by user" });
                }
                return Response.json({ ok: true });
            }

            // Serve embedded HTML for all other routes (SPA)
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

/**
 * Open a URL in the default browser (cross-platform)
 */
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
        console.error(`[Plannotator] Open browser manually: ${url}`);
    }
}

// --- MCP Tool Definition ---

/**
 * MCP Tool Definition for the Model Context Protocol
 */
const mcpToolDefinition = {
    name: "submit_plan",
    description: `Submit your completed implementation plan for interactive user review.

The user will be able to:
- Review your plan visually in a dedicated UI
- Annotate specific sections with feedback (delete, insert, replace, comment)
- Approve the plan to proceed with implementation
- Request changes with detailed feedback

Call this when you have finished creating your implementation plan.
Do NOT proceed with implementation until your plan is approved.`,
    inputSchema: {
        type: "object" as const,
        properties: {
            plan: {
                type: "string",
                description: "The complete implementation plan in markdown format",
            },
            summary: {
                type: "string",
                description: "A brief 1-2 sentence summary of what the plan accomplishes",
            },
        },
        required: ["plan"],
    },
};

/**
 * Handle the submit_plan tool call
 */
async function handleSubmitPlan(args: { plan: string; summary?: string }): Promise<{
    content: Array<{ type: "text"; text: string }>;
}> {
    // Add summary header if provided
    let fullPlan = args.plan;
    if (args.summary) {
        fullPlan = `> **Summary:** ${args.summary}\n\n${args.plan}`;
    }

    // Start the Plannotator server
    const server = await startPlannotatorServer(fullPlan);
    console.error(`\n[Plannotator] Review your plan at: ${server.url}\n`);

    // Open browser automatically
    await openBrowser(server.url);

    // Wait for user decision
    const result = await server.waitForDecision();

    // Give browser time to receive response
    await Bun.sleep(1500);

    // Cleanup
    server.stop();

    if (result.approved) {
        return {
            content: [
                {
                    type: "text",
                    text: `✅ Plan approved!

Your plan has been approved by the user. You may now proceed with implementation.

${args.summary ? `**Plan Summary:** ${args.summary}` : ""}`,
                },
            ],
        };
    } else {
        return {
            content: [
                {
                    type: "text",
                    text: `⚠️ Plan needs revision.

The user has requested changes to your plan. Please review their feedback below and revise your plan accordingly.

## User Feedback

${result.feedback}

---

Please revise your plan based on this feedback and call \`submit_plan\` again when ready.`,
                },
            ],
        };
    }
}

// --- MCP Server Implementation ---

/**
 * Run as MCP server for any MCP-compatible AI coding agent
 *
 * Usage: bunx @plannotator/mcp --mcp
 */
async function runMcpServer() {
    console.error("[Plannotator] Starting MCP server...");

    // Simple stdio-based MCP server
    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete JSON-RPC messages (newline-delimited)
        while (buffer.includes("\n")) {
            const newlineIndex = buffer.indexOf("\n");
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line) continue;

            try {
                const message = JSON.parse(line);
                await handleMcpMessage(message);
            } catch (e) {
                console.error("[Plannotator] Failed to parse message:", e);
            }
        }
    }
}

async function handleMcpMessage(message: {
    jsonrpc: string;
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
}) {
    const { id, method, params } = message;

    // Send JSON-RPC response to stdout
    function respond(result: unknown) {
        const response = JSON.stringify({ jsonrpc: "2.0", id, result });
        console.log(response);
    }

    function respondError(code: number, errorMessage: string) {
        const response = JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code, message: errorMessage },
        });
        console.log(response);
    }

    switch (method) {
        case "initialize":
            respond({
                protocolVersion: "2024-11-05",
                capabilities: {
                    tools: {},
                },
                serverInfo: {
                    name: "plannotator",
                    version: "0.3.0",
                },
            });
            break;

        case "tools/list":
            respond({
                tools: [mcpToolDefinition],
            });
            break;

        case "tools/call":
            if ((params as { name?: string })?.name === "submit_plan") {
                const args = (params as { arguments?: { plan: string; summary?: string } })?.arguments;
                if (!args?.plan) {
                    respondError(-32602, "Missing required parameter: plan");
                    return;
                }
                const result = await handleSubmitPlan(args);
                respond(result);
            } else {
                respondError(-32601, `Unknown tool: ${(params as { name?: string })?.name}`);
            }
            break;

        case "notifications/initialized":
            // Acknowledgement, no response needed
            break;

        default:
            if (id !== undefined) {
                respondError(-32601, `Method not found: ${method}`);
            }
    }
}

// --- Main Entry Point ---

if (process.argv.includes("--mcp")) {
    runMcpServer().catch((err) => {
        console.error("[Plannotator] Fatal error:", err);
        process.exit(1);
    });
} else {
    // Show usage if run without --mcp flag
    console.log(`
Plannotator MCP Server

Interactive plan review for AI coding agents via the Model Context Protocol (MCP).

Compatible with:
  • Cursor
  • GitHub Copilot
  • Windsurf
  • Cline
  • RooCode
  • KiloCode
  • Google Antigravity
  • Any MCP-compatible tool

Usage:
  bunx @plannotator/mcp --mcp

Configuration:
  Add to your MCP configuration file (mcp.json, mcp_config.json, etc.):

  {
    "mcpServers": {
      "plannotator": {
        "command": "bunx",
        "args": ["@plannotator/mcp", "--mcp"]
      }
    }
  }

  Or with npx:

  {
    "mcpServers": {
      "plannotator": {
        "command": "npx",
        "args": ["-y", "@plannotator/mcp", "--mcp"]
      }
    }
  }

Environment Variables:
  PLANNOTATOR_PORT - Fixed port for the review UI (default: random)

For more information, see:
  https://github.com/backnotprop/plannotator
`);
}
