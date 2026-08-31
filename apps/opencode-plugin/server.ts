import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, resolveSharingEnabled } from "@plannotator/shared/config";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import { composeSystemPrompt, stripConflictingPlanModeRules } from "./plan-mode";
import {
  isPlanningAgent,
  normalizeWorkflowOptions,
  shouldInjectFullPlanningPrompt,
  shouldInjectGenericPlanReminder,
  shouldModifyPrompts,
  shouldRegisterSubmitPlan,
  type PlannotatorOpenCodeOptions,
  type RuntimeMode,
} from "./workflow";
import {
  handleCliCommand,
  runCliPlanReview,
  type OpenCodeBridgeAgent,
  type OpenCodeBridgeContext,
  type OpenCodePlanReviewResult,
} from "./cli-bridge";
import { resolveValidatedTargetAgent } from "./agent-switch";
import { shouldFallbackAfterEmbeddedError } from "./prompt-delivery-error";
import { executeSubmitPlan } from "./submit-plan-executor";
import type { PlanEdit } from "./plan-edits";
import { getPlanningPrompt } from "./planning-prompt";

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
let planHtml: string | undefined;

type V2Client = {
  app: {
    agents: () => Promise<{ data: OpenCodeBridgeAgent[] }>;
    log: (entry: { level: "info" | "error"; message: string }) => void;
  };
  session: {
    messages: (input: { path: { id: string } }) => Promise<{ data: LegacyMessage[] }>;
    prompt: (input: LegacyPromptInput) => Promise<unknown>;
  };
};

type LegacyMessage = {
  info: {
    id?: string;
    role: string;
    time?: { created?: string | number | Date };
  };
  parts: Array<{ type: string; text?: string }>;
};

type LegacyPromptInput = {
  path: { id: string };
  body: {
    agent?: string;
    parts: Array<{ type: string; text?: string }>;
  };
};

type NativeCommandInvocation = {
  sessionID: string;
  prompt: { text: string };
  delivery: "steer" | "queue";
};

type NativeCommandDefinition = {
  name: string;
  description: string;
  execute: (input: NativeCommandInvocation) => Promise<void>;
};

type NativeCommandDraft = {
  add?: (definition: NativeCommandDefinition) => void;
};

type V2SessionApi = {
  context: (input: { sessionID: string }) => Promise<unknown>;
  get: (input: { sessionID: string }) => Promise<unknown>;
  prompt: (input: {
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }) => Promise<unknown>;
  switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>;
};

type EmbeddedRuntimeModule = {
  runEmbeddedPlanReview: (input: {
    client: V2Client;
    planContent: string;
    sharingEnabled: boolean;
    shareBaseUrl?: string;
    pasteApiUrl?: string;
    htmlContent: string;
    timeoutSeconds: number | null;
    abortSignal?: AbortSignal;
    logReady: (url: string, isRemote: boolean, port: number) => void;
  }) => Promise<OpenCodePlanReviewResult>;
  handleEmbeddedCommand: (
    command: string,
    event: { properties: { sessionID: string; arguments: string } },
    deps: {
      client: V2Client;
      htmlContent: string;
      reviewHtmlContent: string;
      getSharingEnabled: () => Promise<boolean>;
      getShareBaseUrl: () => string | undefined;
      getPasteApiUrl: () => string | undefined;
      directory?: string;
    },
  ) => Promise<{ approved?: boolean; feedback?: string | null }>;
  deliverEmbeddedAnnotateMessagePrompt: (input: {
    client: V2Client;
    sessionId: string;
    approved: boolean;
    feedback: string;
  }) => Promise<void>;
};

const nativeCommands = [
  {
    name: "plannotator-review",
    description: "Open interactive code review for current changes or a PR URL; pass --git or --gitbutler to force that provider",
  },
  {
    name: "plannotator-annotate",
    description: "Open interactive annotation UI for a file, folder, or URL",
  },
  {
    name: "plannotator-last",
    description: "Annotate the last assistant message",
  },
] as const;

// `Plugin.define` is an identity function in @opencode-ai/plugin; keeping the import
// type-only avoids shipping a runtime dependency on an exact prerelease nightly.
const serverPlugin = {
  id: "plannotator",
  setup: async (ctx) => {
    const workflowOptions = normalizeWorkflowOptions(ctx.options as PlannotatorOpenCodeOptions);
    let cachedAgents: OpenCodeBridgeAgent[] | undefined;

    const getAgents = async (): Promise<OpenCodeBridgeAgent[]> => {
      if (cachedAgents) return cachedAgents;
      try {
        const response = await ctx.agent.list();
        const agents = unwrapData(response);
        cachedAgents = (Array.isArray(agents) ? agents : []).map((agent) => ({
          name: agent.id,
          description: agent.description,
          mode: agent.mode,
          hidden: agent.hidden,
        }));
      } catch {
        cachedAgents = [];
      }
      return cachedAgents;
    };

    const client = createV2Client(ctx, getAgents);

    const registerNativeCommands = async () => {
      await ctx.command.transform((commands) => {
        const draft = commands as NativeCommandDraft;
        // Older V2 nightlies expose command transforms but not executable definitions.
        if (typeof draft.add !== "function") return;
        addNativeCommands(draft, async (command, input) => {
          const session = unwrapData(await ctx.session.get({ sessionID: input.sessionID })) as {
            location?: { directory?: string };
          };
          await runNativeCommand({
            command,
            sessionID: input.sessionID,
            arguments: input.prompt.text,
            directory: session.location?.directory ?? process.cwd(),
            runtime: workflowOptions.runtime,
            client: createV2Client(ctx, getAgents, input.delivery),
            bridge: await getBridgeContext(getAgents),
          });
        });
      });
    };

    await registerNativeCommands();
    void restoreNativeCommandsAfterConfigPlugin(ctx, registerNativeCommands);

    if (shouldModifyPrompts(workflowOptions)) {
      await ctx.session.hook("context", async (event) => {
        if (
          workflowOptions.workflow === "plan-agent"
          && !isPlanningAgent(event.agent, workflowOptions)
        ) {
          delete event.tools.submit_plan;
          return;
        }

        const currentAgent = workflowOptions.workflow === "all-agents"
          ? (await getAgents()).find((candidate) => candidate.name === event.agent)
          : undefined;
        if (!allowSubagents() && currentAgent?.mode === "subagent") {
          delete event.tools.submit_plan;
          return;
        }

        if (event.tools.plan_exit) {
          event.tools.plan_exit.description =
            "Do not call this tool. Use submit_plan instead - it opens a visual review UI for plan approval.";
        }
        if (event.tools.todowrite) {
          event.tools.todowrite.description =
            "While actively planning with the user, use submit_plan instead. Only use todos once implementation begins or unless the user explicitly asks.";
        }

        replaceStrictPlanReminder(event.messages);

        const systemText = event.system.map((part) => part.text).join("\n").toLowerCase();
        if (systemText.includes("title generator") || systemText.includes("generate a title")) return;

        if (shouldInjectFullPlanningPrompt(event.agent, workflowOptions)) {
          const additions = [getPlanningPrompt()];
          const hook = readImprovementHook("enterplanmode-improve");
          const improveContext = composeImproveContext({
            pfmEnabled: loadConfig().pfmReminder === true,
            improvementHookContent: hook?.content ?? null,
          });
          if (improveContext) additions.push(improveContext);
          replacePlanningSystemParts(
            event.system,
            additions,
          );
          return;
        }

        if (!shouldInjectGenericPlanReminder(
          event.agent,
          currentAgent?.mode === "subagent",
          workflowOptions,
        )) return;

        pushComposedSystemReminder(event.system, getGenericPlanReminder());
      });
    }

    if (!shouldRegisterSubmitPlan(workflowOptions)) return;

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "submit_plan",
        description:
          "Submit a plan for user review via line-range edits. First call: pass a single edit with start=1 and your full plan as content (omit end). Subsequent calls after denial: pass targeted edits using the line numbers from the previous response. The tool manages a backing file; you never touch the file directly.",
        input: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: {
                    type: "number",
                    description: "1-indexed start line (inclusive)",
                  },
                  end: {
                    type: "number",
                    description: "1-indexed end line (inclusive). Omit to replace from start through end of file.",
                  },
                  content: {
                    type: "string",
                    description: "Replacement content. Empty string deletes the line range.",
                  },
                },
                required: ["start", "content"],
                additionalProperties: false,
              },
              description: "Array of line-range edits to apply to the plan.",
            },
          },
          required: ["edits"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, toolContext) => {
          const session = await ctx.session.get({ sessionID: toolContext.sessionID });
          const directory = (unwrapData(session) as { location: { directory: string } }).location.directory;
          const bridge = await getBridgeContext(getAgents);
          const result = await executeSubmitPlan({
            edits: getPlanEdits(input),
            invokingAgent: toolContext.agent,
            sessionId: toolContext.sessionID,
            directory,
            workflowOptions,
          }, {
            reviewPlan: async ({ planContent }) => await runPlanReview({
              client,
              runtime: workflowOptions.runtime,
              planContent,
              sharingEnabled: bridge.sharingEnabled ?? true,
              shareBaseUrl: bridge.shareBaseUrl,
              pasteApiUrl: bridge.pasteApiUrl,
              timeoutSeconds: getPlanTimeoutSeconds(),
              directory,
              bridge,
            }),
            resolveTargetAgent: async ({ requestedAgent, directory, delivery }) =>
              await resolveValidatedTargetAgent({
                client,
                targetAgent: requestedAgent,
                directory,
                delivery,
            }),
            sendApprovalHandoff: async ({ sessionId, targetAgent }) => {
              const session = ctx.session as unknown as V2SessionApi;
              await session.switchAgent?.({ sessionID: sessionId, agent: targetAgent });
            },
          });

          return { content: result };
        },
      });
    });
  },
} satisfies Plugin.Plugin;

function getPlanEdits(input: unknown): PlanEdit[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const edits = Reflect.get(input, "edits");
  return Array.isArray(edits) ? edits as PlanEdit[] : undefined;
}

function getPlanTimeoutSeconds(): number | null {
  const raw = process.env.PLANNOTATOR_PLAN_TIMEOUT_SECONDS?.trim();
  if (!raw) return DEFAULT_PLAN_TIMEOUT_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`[Plannotator] Invalid PLANNOTATOR_PLAN_TIMEOUT_SECONDS="${raw}". Using default ${DEFAULT_PLAN_TIMEOUT_SECONDS}s.`);
    return DEFAULT_PLAN_TIMEOUT_SECONDS;
  }
  return parsed === 0 ? null : parsed;
}

export function createV2Client(
  ctx: { session: unknown },
  getAgents: () => Promise<OpenCodeBridgeAgent[]>,
  delivery: "steer" | "queue" = "steer",
): V2Client {
  const loggedUrls = new Set<string>();
  const session = ctx.session as V2SessionApi;
  return {
    app: {
      agents: async () => ({ data: await getAgents() }),
      log: ({ message }) => {
        const url = /https?:\/\/\S+/.exec(message)?.[0];
        if (url && loggedUrls.has(url)) return;
        if (url) loggedUrls.add(url);
        console.error(message);
      },
    },
    session: {
      messages: async ({ path }) => {
        const messages = unwrapData(await session.context({ sessionID: path.id }));
        return {
          data: Array.isArray(messages)
            ? messages.flatMap(toLegacyMessage)
            : [],
        };
      },
      prompt: async ({ path, body }) => {
        if (body.agent && session.switchAgent) {
          await session.switchAgent({ sessionID: path.id, agent: body.agent });
        }
        return await session.prompt({
          sessionID: path.id,
          text: body.parts
            .filter((part) => part.type === "text" && part.text)
            .map((part) => part.text)
            .join("\n"),
          delivery,
        });
      },
    },
  };
}

async function restoreNativeCommandsAfterConfigPlugin(
  ctx: { event: { subscribe: () => AsyncIterable<unknown> } },
  register: () => Promise<void>,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe()) {
      if (
        !event
        || typeof event !== "object"
        || Reflect.get(event, "type") !== "plugin.added"
      ) continue;
      const data = Reflect.get(event, "data");
      if (!data || typeof data !== "object" || Reflect.get(data, "id") !== "opencode.config.command") continue;

      // Config commands load after package plugins and overwrite duplicate names.
      // Register once more so these executable callbacks win over the V1 stubs.
      await register();
      return;
    }
  } catch (error) {
    console.error(`[Plannotator] Could not finalize native command registration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function unwrapData(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("data" in value)) return value;
  return Reflect.get(value, "data");
}

function toLegacyMessage(message: unknown): LegacyMessage[] {
  if (!message || typeof message !== "object" || Reflect.get(message, "type") !== "assistant") return [];
  const content = Reflect.get(message, "content");
  if (!Array.isArray(content)) return [];
  return [{
    info: {
      id: typeof Reflect.get(message, "id") === "string" ? Reflect.get(message, "id") : undefined,
      role: "assistant",
      time: Reflect.get(message, "time") as LegacyMessage["info"]["time"],
    },
    parts: content.flatMap((part) =>
      part && typeof part === "object" && Reflect.get(part, "type") === "text"
        ? [{ type: "text", text: String(Reflect.get(part, "text") ?? "") }]
        : []
    ),
  }];
}

function addNativeCommands(
  draft: NativeCommandDraft,
  execute: (command: string, input: NativeCommandInvocation) => Promise<void>,
): void {
  if (!draft.add) return;
  for (const command of nativeCommands) {
    draft.add({
      ...command,
      execute: async (input) => await execute(command.name, input),
    });
  }
}

async function runNativeCommand(input: {
  command: string;
  sessionID: string;
  arguments: string;
  directory?: string;
  runtime: RuntimeMode;
  client: V2Client;
  bridge: OpenCodeBridgeContext;
}): Promise<void> {
  const event = {
    properties: {
      sessionID: input.sessionID,
      arguments: input.arguments,
    },
  };

  if (input.runtime !== "cli" && hasEmbeddedRuntime()) {
    try {
      const embedded = await importEmbeddedRuntime();
      const result = await embedded.handleEmbeddedCommand(input.command, event, {
        client: input.client,
        htmlContent: getPlanHtml(),
        reviewHtmlContent: getReviewHtml(),
        getSharingEnabled: async () => input.bridge.sharingEnabled ?? true,
        getShareBaseUrl: () => input.bridge.shareBaseUrl,
        getPasteApiUrl: () => input.bridge.pasteApiUrl,
        directory: input.directory,
      });
      if (input.command === "plannotator-last" && result.feedback) {
        await embedded.deliverEmbeddedAnnotateMessagePrompt({
          client: input.client,
          sessionId: input.sessionID,
          approved: Boolean(result.approved),
          feedback: result.feedback,
        });
      }
      return;
    } catch (error) {
      if (!shouldFallbackAfterEmbeddedError(input.runtime, error)) throw error;
      console.error(`[Plannotator] Embedded runtime unavailable; falling back to CLI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (input.runtime === "embedded") {
    console.error("[Plannotator] runtime \"embedded\" requires a Bun-hosted OpenCode plugin runtime. Use runtime \"auto\" or \"cli\" with this OpenCode host.");
    return;
  }

  await handleCliCommand({
    command: input.command,
    client: input.client,
    sessionId: input.sessionID,
    rawArgs: input.arguments,
    cwd: input.directory,
    bridge: input.bridge,
  });
}

function allowSubagents(): boolean {
  const value = process.env.PLANNOTATOR_ALLOW_SUBAGENTS?.trim();
  return value === "1" || value === "true";
}

async function getBridgeContext(
  getAgents: () => Promise<OpenCodeBridgeAgent[]>,
): Promise<OpenCodeBridgeContext> {
  return {
    sharingEnabled: resolveSharingEnabled(loadConfig()),
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
    agents: await getAgents(),
  };
}

function hasEmbeddedRuntime(): boolean {
  return typeof (globalThis as typeof globalThis & { Bun?: { serve?: unknown } }).Bun?.serve === "function";
}

async function importEmbeddedRuntime(): Promise<EmbeddedRuntimeModule> {
  const builtPath = path.join(moduleDir, "embedded.js");
  if (existsSync(builtPath)) {
    return await import(pathToFileURL(builtPath).href) as EmbeddedRuntimeModule;
  }
  const sourceSpecifier = "./embedded";
  return await import(sourceSpecifier) as EmbeddedRuntimeModule;
}

function getPlanHtml(): string {
  if (planHtml) return planHtml;
  const candidates = [
    path.join(moduleDir, "plannotator.html"),
    path.join(moduleDir, "..", "plannotator.html"),
  ];
  const htmlPath = candidates.find((candidate) => existsSync(candidate));
  if (!htmlPath) throw new Error("Could not find bundled HTML asset: plannotator.html");
  planHtml = readFileSync(htmlPath, "utf-8");
  return planHtml;
}

function getReviewHtml(): string {
  const candidates = [
    path.join(moduleDir, "review-editor.html"),
    path.join(moduleDir, "..", "review-editor.html"),
  ];
  const htmlPath = candidates.find((candidate) => existsSync(candidate));
  if (!htmlPath) throw new Error("Could not find bundled HTML asset: review-editor.html");
  return readFileSync(htmlPath, "utf-8");
}

async function runPlanReview(input: {
  client: V2Client;
  runtime: RuntimeMode;
  planContent: string;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  timeoutSeconds: number | null;
  abortSignal?: AbortSignal;
  directory: string;
  bridge: OpenCodeBridgeContext;
}): Promise<OpenCodePlanReviewResult> {
  if (input.runtime === "embedded" && !hasEmbeddedRuntime()) {
    throw new Error('runtime "embedded" requires a Bun-hosted OpenCode plugin runtime. Use runtime "auto" or "cli" with this OpenCode host.');
  }

  if (input.runtime !== "cli" && hasEmbeddedRuntime()) {
    try {
      const embedded = await importEmbeddedRuntime();
      return await embedded.runEmbeddedPlanReview({
        client: input.client,
        planContent: input.planContent,
        sharingEnabled: input.sharingEnabled,
        shareBaseUrl: input.shareBaseUrl,
        pasteApiUrl: input.pasteApiUrl,
        htmlContent: getPlanHtml(),
        timeoutSeconds: input.timeoutSeconds,
        abortSignal: input.abortSignal,
        // Intentionally empty. OpenCode 2's server-plugin context exposes no log or
        // tui domain, and the V2 client's app.log falls through to console.error,
        // which is the same stderr stream handleServerReady already prints to.
        // Wiring this up would duplicate the session URL in remote mode and add a
        // stray line locally. V1 does target client.app.log and client.tui.showToast,
        // which are HTTP surfaces separate from stderr, so V1 never repeats itself.
        // A real toast here needs an upstream OpenCode API that does not exist yet.
        logReady: () => {},
      });
    } catch (error) {
      if (input.runtime === "embedded") throw error;
      console.error(`[Plannotator] Embedded runtime unavailable; falling back to CLI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return await runCliPlanReview({
    client: input.client,
    planContent: input.planContent,
    cwd: input.directory,
    timeoutSeconds: input.timeoutSeconds,
    abortSignal: input.abortSignal,
    bridge: input.bridge,
  });
}

type SystemPart = { type: "text"; text: string; [key: string]: unknown };

/**
 * Replace the system array with ONE composed text part (#1114): multiple
 * system parts corrupt Qwen3.x Jinja chat templates, which render each part
 * as its own system message. Mirrors the V1 entry (index.ts) exactly —
 * stripped existing text first, then the additions, joined by blank lines.
 *
 * Order matters: the existing texts are read and composed BEFORE the array is
 * truncated. Reordering to `system.length = 0` first silently drops the
 * host's entire system prompt (the bug class flagged in #1114's review).
 *
 * Accepted trade-off: consolidation flattens per-part metadata (e.g.
 * third-party cache hints) — template integrity beats part-level caching.
 */
export function replacePlanningSystemParts(
  system: SystemPart[],
  additions: string[],
): void {
  const stripped = stripConflictingPlanModeRules(system.map((part) => part.text));
  const composed = composeSystemPrompt([], [...stripped, ...additions.filter(Boolean)]);
  system.length = 0;
  system.push(...composed.map((text) => ({ type: "text" as const, text })));
}

/**
 * Append a reminder by composing it into a single system part (#1114) instead
 * of pushing a separate part — same Jinja-template rationale as above, and
 * the same compose-before-truncate ordering requirement.
 */
export function pushComposedSystemReminder(
  system: SystemPart[],
  reminder: string,
): void {
  const composed = composeSystemPrompt(system.map((part) => part.text), [reminder]);
  system.length = 0;
  system.push(...composed.map((text) => ({ type: "text" as const, text })));
}

function replaceStrictPlanReminder(messages: unknown[]): void {
  for (const message of messages) {
    if (!message || typeof message !== "object" || Reflect.get(message, "role") !== "user") continue;
    const content = Reflect.get(message, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Reflect.get(part, "type") !== "text") continue;
      const text = Reflect.get(part, "text");
      if (typeof text !== "string" || !text.includes("STRICTLY FORBIDDEN")) continue;
      Reflect.set(part, "text", `<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE. You are in a PLANNING phase. The ONLY file modifications
allowed are writing or editing markdown files (.md) - plans, specs, documentation, etc.
All other file edits, code modifications, and system changes are STRICTLY FORBIDDEN.
Do NOT use shell commands to manipulate non-markdown files. Commands may ONLY read/inspect.

Use submit_plan to submit the completed plan for user review. Do not proceed with
implementation until the plan is approved.
</system-reminder>`);
    }
  }
}

function getGenericPlanReminder(): string {
  return `## Plan Submission

When you have completed your plan, call the \`submit_plan\` tool to submit it for user review. Pass your full plan as a single edit: \`{ "edits": [{ "start": 1, "content": "..." }] }\`.

The user will review your plan in a visual UI where they can annotate, approve, or request changes. If rejected, the response includes your plan with line numbers; use targeted edits to revise specific sections.

Do NOT proceed with implementation until your plan is approved.`;
}

export default serverPlugin;
