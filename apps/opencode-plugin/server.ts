import type { Plugin } from "@opencode/plugin";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, resolveAgentTool, resolveSharingEnabled } from "@plannotator/shared/config";
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
  runCliPlanReview,
  type OpenCodeBridgeAgent,
  type OpenCodeBridgeContext,
  type OpenCodePlanReviewResult,
} from "./cli-bridge";
import { switchV2SessionAgent } from "./agent-switch";
import { registerNativeCommands, runNativeCommand, type NativeCommandDeps } from "./native-commands";
import {
  PLANNOTATOR_TOOL_DESCRIPTION,
  PLANNOTATOR_TOOL_INPUT_SCHEMA,
  PLANNOTATOR_TOOL_NAME,
} from "@plannotator/shared/plannotator-tool";
import { OpenCodeLaunchRegistry, runPlannotatorTool, type LaunchHandle, type PlannotatorToolDeps } from "./plannotator-tool";
import {
  createV2BridgeClient,
  dropSessionUrlNotices,
  formatSessionUrlNotice,
  normalizeAgentList,
  type V2ContextLike,
} from "./v2-client";
import { executeSubmitPlan } from "./submit-plan-executor";
import type { SessionBridge } from "@plannotator/ai/session-bridge";
import { createOpenCodeSessionBridge, markPlanReviewPending } from "./opencode-session-bridge";
import type { PlanEdit } from "./plan-edits";
import { getPlanningPrompt } from "./planning-prompt";
import { findInboxConnection, registerInboxOpenCode2, type InboxToolDomainLike } from "./inbox";
import { createOpenCodeSnapshots, type OpenCodeSnapshots } from "./snapshots";

const DEFAULT_PLAN_TIMEOUT_SECONDS = 345_600;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
let planHtml: string | undefined;

type V2Client = {
  app: {
    agents: () => Promise<{ data: OpenCodeBridgeAgent[] }>;
    log: (entry: { level: "info" | "error"; message: string }) => void;
  };
  /**
   * Visible delivery for the session URL, present only when the host can post
   * a transcript notice. `cli-bridge` prefers it over the (absent on V2) toast
   * for the CLI runtime; `createPlanReadyNotifier` is the embedded runtime's
   * equivalent. See `createSessionUrlNotifier` in `v2-client.ts`.
   */
  notifyUrl?: (input: { url: string; message: string }) => Promise<unknown>;
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
    sessionBridge?: SessionBridge;
    opencodeToolCapable?: boolean;
  }) => Promise<OpenCodePlanReviewResult>;
};

// `Plugin.define` is an identity function in @opencode/plugin; keeping the import
// type-only lets the host provide the runtime without shipping a second SDK.
const serverPlugin = {
  id: "plannotator",
  setup: async (ctx) => {
    const workflowOptions = normalizeWorkflowOptions(ctx.options as PlannotatorOpenCodeOptions);
    let cachedAgents: OpenCodeBridgeAgent[] | undefined;

    const getAgents = async (): Promise<OpenCodeBridgeAgent[]> => {
      if (cachedAgents) return cachedAgents;
      try {
        // The documented success shape is the `{ location, data }` envelope.
        // `normalizeAgentList` also accepts a bare array because reading
        // `.data` off anything else throws into this catch, where the failure
        // is invisible: an empty agent list silently disables subagent gating
        // and agent-switch validation rather than reporting anything.
        cachedAgents = normalizeAgentList(await ctx.agent.list());
      } catch {
        cachedAgents = [];
      }
      return cachedAgents;
    };

    // Keep the capability probes for older V2 hosts, even though the stable
    // SDK now types native command execution and agent switching.
    const v2 = ctx as unknown as V2ContextLike;

    // Native slash commands are registered before the submit_plan early return
    // below, so `workflow: "manual"`, which registers no tool, still gets them.
    // Wrapped because a transform rejection must never fail plugin setup: the
    // whole Plannotator integration would go down for a slash command that has
    // a working markdown fallback.
    // Every review this plugin opens, per OpenCode session: the `plannotator`
    // tool's list/close read it, and the slash commands record theirs too.
    const launches = new OpenCodeLaunchRegistry();
    // OpenCode 1.18 also runs this setup, with its Promise-plugin context that
    // has no `session` or `tool` domain (and posts no notices). Every use of
    // those domains is probed, so setup completes there instead of throwing.
    const hasSessionHooks = typeof (ctx.session as { hook?: unknown } | undefined)?.hook === "function";
    const hasToolTransform = typeof (ctx.tool as { transform?: unknown } | undefined)?.transform === "function";
    // Plannotator Snapshots (`/plannotator-snapshot` and each session's link
    // to the Snapshots hub, snapshots.ts): on unless PLANNOTATOR_SNAPSHOTS /
    // `snapshots` turn it off, decided once per plugin setup. Only where the
    // plugin can prompt a session (the Send arrives as a turn); OpenCode 1
    // keeps the markdown stub's blocking `plannotator snapshot --wait`.
    let snapshots: OpenCodeSnapshots | null = null;
    if (typeof v2.session?.prompt === "function") {
      try {
        snapshots = createOpenCodeSnapshots(v2, { resolveRoot: (sessionID) => resolveRootSession(v2, sessionID) });
      } catch (error) {
        console.error(`[Plannotator] Could not set up Plannotator Snapshots: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const nativeDeps: NativeCommandDeps = {
      ctx: v2,
      getAgents,
      // Whether this host could register the `plannotator` tool rides along,
      // so the reviews it opens offer the tool's switch only where it exists.
      getBridgeContext: () => getBridgeContext(getAgents, hasToolTransform),
      launches,
      ...(snapshots ? { extraCommands: [snapshots.command] } : {}),
    };
    try {
      await registerNativeCommands(nativeDeps);
    } catch (error) {
      console.error(`[Plannotator] Could not register the OpenCode 2 slash commands: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The session-URL notice is for the person, never the model: once promoted
    // it could land after a plan decision's tool result and be answered
    // instead of the decision. Registered for every workflow, since the
    // notice is posted by the slash commands too. See `dropSessionUrlNotices`.
    if (hasSessionHooks) {
      try {
        await ctx.session.hook("context", (event) => {
          dropSessionUrlNotices(event.messages as unknown[]);
        });
        // `session.generate` (plan review's "Quick answer from this session")
        // builds its request through its own hook with the same shape
        // (`agentHook("generate", …)` in core's model-request.ts), so the
        // notice is kept out of those answers too.
        await ctx.session.hook("generate", (event) => {
          dropSessionUrlNotices(event.messages as unknown[]);
        });
      } catch (error) {
        console.error(`[Plannotator] Could not register the session-URL notice filter: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The `plannotator` tool (annotate / review / last / list / close), for
    // every workflow: it opens reviews through the slash commands' own launch
    // and returns at once. Wrapped like the commands: a failed registration
    // must not take the plugin down. Off by default on OpenCode 2; on with
    // PLANNOTATOR_AGENT_TOOL=1 or `{ "agentTool": true }`, decided here once per
    // plugin setup: the tool list is part of the prompt, so a change applies
    // when OpenCode restarts.
    if (hasToolTransform && resolveAgentTool(loadConfig(), process.env, "opencode")) {
      try {
        await registerPlannotatorTool(ctx.tool as unknown as ToolDomainLike, v2, {
          registry: launches,
          launch: (request) => runNativeCommand(
            request.command,
            { sessionID: request.sessionID, prompt: { text: request.rawArgs } },
            nativeDeps,
            { launch: request.launch, annotateArgs: request.annotateArgs, annotateBundle: request.annotateBundle, notice: request.notice },
          ),
          resolveOwner: (sessionID) => resolveRootSession(v2, sessionID),
          reportLateFailure: async ({ sessionID, text }) => {
            // The person sees it in the transcript (OpenCode 2's plugin
            // context has no toast surface), and the agent reads it as a
            // turn, so neither keeps waiting. "queue": a late arrival.
            console.error(`[Plannotator] ${text.split("\n").find((line) => line.startsWith("Plannotator could not start")) ?? text}`);
            await v2.session?.prompt?.({ sessionID, text, delivery: "queue" });
          },
        });
      } catch (error) {
        console.error(`[Plannotator] Could not register the plannotator tool: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The Plannotator Inbox (`plannotator_inbox` and the reply wake, inbox.ts):
    // only where the inbox tool switch allows it for OpenCode and an Inbox was
    // found, decided here once per plugin setup (the tool list is part of the
    // prompt). Wrapped like the tool above: a failure must not take the plugin down.
    if (hasToolTransform) {
      try {
        const inbox = await findInboxConnection();
        if (inbox) await registerInboxOpenCode2(ctx.tool as unknown as InboxToolDomainLike, v2, inbox, (sessionID) => resolveRootSession(v2, sessionID));
      } catch (error) {
        console.error(`[Plannotator] Could not register the plannotator_inbox tool: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (hasSessionHooks && shouldModifyPrompts(workflowOptions)) {
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

    if (!hasToolTransform || !shouldRegisterSubmitPlan(workflowOptions)) return;

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
          const directory = session.location.directory;
          const bridge = await getBridgeContext(getAgents, hasToolTransform);
          // Same client the native command path uses, and for the same reason:
          // `sessionID` is what lets the session URL reach a remote reviewer, who
          // gets no browser opened and cannot see the plugin's console output.
          const client = createV2BridgeClient({
            ctx: v2,
            getAgents,
            sessionID: toolContext.sessionID,
          });
          // While the plan waits, the session is inside this tool call: a real
          // turn cannot run (and interrupting would kill the review), so every
          // bridge on this session reports `blocked`, and the plan review's own
          // bridge answers from context only ("Quick answer", session.generate).
          const releasePlanPending = markPlanReviewPending(toolContext.sessionID);
          const planBridge = typeof v2.session?.generate === "function"
            ? createOpenCodeSessionBridge({
              ctx: v2,
              sessionID: toolContext.sessionID,
              modes: { turn: false, transient: true },
            })
            : undefined;
          // Listed by the tool's `list` while it waits (never closable there:
          // a plan review ends with the reviewer's decision).
          const planLaunch = launches.begin(toolContext.sessionID, "plan", "Plan");
          try {
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
                sessionBridge: planBridge,
                launch: planLaunch,
              }),
              resolveTargetAgent: async ({ requestedAgent }) => await switchV2SessionAgent({
                ctx: v2,
                sessionID: toolContext.sessionID,
                requestedAgent,
                getAgents,
              }),
              // The switch above is the whole handoff on V2. Its session.prompt
              // has no `noReply` equivalent, so an injected approval note would
              // start a model turn the reviewer never asked for; the submit_plan
              // tool result already carries the approval text.
              sendApprovalHandoff: async () => {},
            });

            return { content: result };
          } finally {
            planLaunch.end();
            planBridge?.dispose();
            releasePlanPending();
            // Same call as `runNativeCommand`: closes the session-URL notice
            // watch for a review that delivered no prompt of its own.
            client.dispose();
          }
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

function allowSubagents(): boolean {
  const value = process.env.PLANNOTATOR_ALLOW_SUBAGENTS?.trim();
  return value === "1" || value === "true";
}

async function getBridgeContext(
  getAgents: () => Promise<OpenCodeBridgeAgent[]>,
  /** The host has a tool domain, so it can register the `plannotator` tool. */
  toolCapable: boolean,
): Promise<OpenCodeBridgeContext> {
  return {
    sharingEnabled: resolveSharingEnabled(loadConfig()),
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
    agents: await getAgents(),
    ...(toolCapable ? { toolCapable: true } : {}),
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

/**
 * The embedded runtime's ready hook: put the session URL where a reviewer can
 * see it, and nowhere else.
 *
 * This still must NOT go to `client.app.log`. That is `console.error`, the same
 * stderr stream `handleServerReady` has already printed the URL to, so logging
 * here would duplicate the line in remote mode and add a stray one locally
 * (which is why this hook used to be empty). The transcript notice is a
 * different surface entirely, and on OpenCode 2 it is the only one a remote
 * reviewer can actually see: the host discards a server plugin's stderr unless
 * it was started with `OPENCODE_PRINT_LOGS=1`.
 *
 * Best-effort in both directions: an older host exposes no `session.synthetic`,
 * so `notifyUrl` is absent and this stays silent, exactly as before.
 */
export function createPlanReadyNotifier(
  client: V2Client,
  /** Also told the server is up: the tool's `list` entry for this plan review. */
  onServer?: (info: { url: string; port?: number; isRemote: boolean }) => void,
): (url: string, isRemote?: boolean, port?: number) => void {
  return (url: string, isRemote?: boolean, port?: number) => {
    try {
      onServer?.({ url, ...(port !== undefined ? { port } : {}), isRemote: isRemote === true });
    } catch {
      // The list entry is best-effort.
    }
    const notify = client.notifyUrl;
    if (typeof notify !== "function") return;
    try {
      void notify({ url, message: formatSessionUrlNotice(url) }).catch(() => {
        // A cosmetic notice must never surface as an unhandled rejection.
      });
    } catch {
      // Visible URL delivery is best-effort.
    }
  };
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
  /** "Ask this session" while the plan waits (transient answers only). */
  sessionBridge?: SessionBridge;
  /** The plan review's entry in the tool's list: learns the url once it is up. */
  launch?: LaunchHandle;
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
        logReady: createPlanReadyNotifier(input.client, input.launch?.observer.onServer),
        sessionBridge: input.sessionBridge,
        ...(input.bridge.toolCapable ? { opencodeToolCapable: true } : {}),
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
    sessionBridge: input.sessionBridge,
    ...(input.launch ? { observer: input.launch.observer } : {}),
  });
}

/**
 * The root of `sessionID`'s parent chain. A subagent runs in a child session
 * (`parentID`); its `plannotator` reviews belong to the root session, where the
 * person is, as on the Claude Code mod. A chain that cannot be read stops
 * where it is.
 */
export async function resolveRootSession(v2: V2ContextLike, sessionID: string): Promise<{ root: string; subagent: boolean }> {
  let current = sessionID;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < 16; depth++) {
    let parentID: unknown;
    try {
      const session: unknown = await v2.session?.get?.({ sessionID: current });
      parentID = session && typeof session === "object" ? Reflect.get(session, "parentID") : undefined;
    } catch {
      break;
    }
    if (typeof parentID !== "string" || !parentID || seen.has(parentID)) break;
    seen.add(parentID);
    current = parentID;
  }
  return { root: current, subagent: current !== sessionID };
}

/** The part of OpenCode 2's tool domain the `plannotator` tool needs (probed: older hosts differ). */
export interface ToolDomainLike {
  transform?: (apply: (tools: { add?: (tool: Record<string, unknown>) => void }) => void) => Promise<unknown> | unknown;
}

/**
 * Register the `plannotator` tool (contract `packages/shared/plannotator-tool.ts`:
 * the shared name, description and JSON schema, never a copy). Nothing is
 * registered on a host whose tool draft has no `add`, or whose session domain
 * cannot `prompt` (the reviewer's decision could never come back). Returns
 * whether the draft took it; like the commands, the callback may run later
 * under boot batching, so the answer is read after `transform` resolves.
 */
export async function registerPlannotatorTool(
  toolDomain: ToolDomainLike | undefined,
  v2: V2ContextLike,
  deps: PlannotatorToolDeps,
): Promise<boolean> {
  const transform = toolDomain?.transform;
  if (typeof transform !== "function") return false;
  if (typeof v2.session?.prompt !== "function") return false;
  let added = false;
  await transform((tools) => {
    if (typeof tools?.add !== "function") return;
    added = true;
    tools.add({
      name: PLANNOTATOR_TOOL_NAME,
      description: PLANNOTATOR_TOOL_DESCRIPTION,
      input: PLANNOTATOR_TOOL_INPUT_SCHEMA,
      options: { codemode: false },
      execute: async (input: unknown, toolContext: { sessionID: string }) => ({
        content: await runPlannotatorTool(input, { sessionID: toolContext.sessionID }, deps),
      }),
    });
  });
  return added;
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
