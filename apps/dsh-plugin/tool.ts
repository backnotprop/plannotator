/**
 * The `plannotator` agent tool and the `/plannotator-review`,
 * `/plannotator-annotate` and `/plannotator-last` commands on DeepSeek
 * Harness. The tool is the shared contract (packages/shared/plannotator-tool.ts,
 * the one Pi and OpenCode 2 register), registered with `ctx.tools.register`;
 * the commands with `ctx.commands.register`. Both open reviews through
 * reviews.ts: the call returns once the page is up, and the person's decision
 * arrives later in the session as a new turn (`agent.followup`). Nothing waits
 * inside a tool call for a person.
 *
 * The tool follows the agent tool switch (`PLANNOTATOR_AGENT_TOOL`, then
 * config `agentTool`, then AGENT_TOOL_DEFAULTS.dsh, off: DSH sends every
 * tool's definition with each request), read once at plugin load. The
 * commands do not depend on it: they cost the model nothing. Neither is
 * registered in the `headless`, `sdk`, `sdk-minimal` or `acp` profiles, whose
 * client did not ask for turns of ours; there the shared skills still run the
 * CLI.
 *
 * Plan review is not part of the tool: it stays on `exit_plan_mode`
 * (plan-review.ts).
 */

import { loadConfig, resolveAgentTool, type PlannotatorConfig } from "../../packages/shared/config";
import { annotateTargetWords, parseAnnotateArgs } from "../../packages/shared/annotate-args";
import { tokenizeReviewArgs } from "../../packages/shared/review-args";
import {
  looksLikeFilePath,
  parsePlannotatorToolInput,
  PLANNOTATOR_TOOL_DESCRIPTION,
  PLANNOTATOR_TOOL_INPUT_SCHEMA,
  PLANNOTATOR_TOOL_NAME,
  plannotatorBundleSubject,
  plannotatorTargetSubject,
  plannotatorToolArgs,
  plannotatorToolOpenedText,
  plannotatorToolTargets,
  scriptOnlyAnnotateFlag,
  scriptOnlyAnnotateFlagText,
  type PlannotatorToolInput,
} from "../../packages/shared/plannotator-tool";
import { agentsServiceOf, DSH_NO_WAKE_PROFILES, rootAgentOf, type DshAgentsService, type DshInboxAgent, type DshInboxContext, type DshToolsService } from "./inbox";
import { createUserMessage, sessionCwd, type DshContext } from "./plan-review";
import { DSH_LAST_SUBJECT, DSH_LOCAL_CHANGES_SUBJECT, DshReviews, dshStartFailureText, type DshReviewKind, type DshReviewRequest } from "./reviews";

export const DSH_AGENT_TOOL_HOST = "dsh";

/** The commands, by name (DSH's command names: lowercase, `[a-z][a-z0-9_-]*`). */
export const DSH_COMMANDS = {
  review: "plannotator-review",
  annotate: "plannotator-annotate",
  last: "plannotator-last",
} as const;

/** `last` from a subagent: it reads the main session's messages, which the subagent did not write. */
export const DSH_SUBAGENT_LAST_TEXT =
  'Invalid plannotator call: action "last" annotates the main session\'s last message and is not available to a subagent.';

/** `ctx.commands` (CommandRegistry): only `register`. */
export interface DshCommandsService {
  register(definition: DshCommandDefinition): unknown;
}

export type DshCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

export interface DshCommandDefinition {
  name: string;
  description: string;
  input?: { hint: string };
  handler(invocation: { agent: DshInboxAgent; rawInput: string; signal?: AbortSignal }): Promise<DshCommandResult>;
}

export interface DshNativeDeps {
  env?: NodeJS.ProcessEnv;
  /** Plannotator's config (default: config.json in the data dir). */
  config?: PlannotatorConfig;
  /** The program to run instead of the resolved binary (tests: a fake CLI). */
  command?: string[];
  /** How often a launch looks for the page (tests). */
  pollMs?: number;
  /** How long a call waits for the page before answering "starting" (tests). */
  readyWaitMs?: { review: number; other: number };
}

function service<T>(ctx: DshInboxContext, name: string): T | undefined {
  try {
    return (ctx.get?.(name) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

function warnOf(ctx: DshInboxContext) {
  return (format: string, ...args: unknown[]) => {
    try {
      ctx.logger?.warn?.(format, ...args);
    } catch {
      // Logging is best-effort.
    }
  };
}

/** Whether this DSH profile takes turns of ours (not `headless`, `sdk`, `sdk-minimal` or `acp`). */
export function profileTakesTurns(ctx: DshInboxContext): boolean {
  const profile = service<{ name?: unknown }>(ctx, "profileContext");
  return !(typeof profile?.name === "string" && DSH_NO_WAKE_PROFILES.includes(profile.name));
}

/** DSH's home as the running profile resolved it (`profileContext.home`), for `last`. */
export function dshHomeOf(ctx: DshInboxContext): string | undefined {
  const home = service<{ home?: unknown }>(ctx, "profileContext")?.home;
  return typeof home === "string" && home ? home : undefined;
}

/** The DSH session id of an agent: its session header id, else the agent id. */
function sessionIdOf(agent: DshInboxAgent): string {
  const id = agent.session?.header?.id;
  return typeof id === "string" && id ? id : agent.id;
}

/** The subject of a tool call's review. */
export function toolSubject(call: PlannotatorToolInput): string {
  const targets = plannotatorToolTargets(call);
  switch (call.action) {
    case "annotate":
      return Array.isArray(call.target) ? plannotatorBundleSubject(targets) : plannotatorTargetSubject("annotate", targets[0]) ?? (targets[0] as string);
    case "review":
      return targets[0] ? plannotatorTargetSubject("review", targets[0]) ?? (targets[0] as string) : DSH_LOCAL_CHANGES_SUBJECT;
    default:
      return DSH_LAST_SUBJECT;
  }
}

/**
 * A command's words, the way every other host reads its review arguments
 * (`tokenizeReviewArgs`): whitespace separates, quotes group, and a backslash
 * is an ordinary character, so a typed `C:\dev\feature` reaches the CLI whole.
 */
function commandWords(raw: string): string[] {
  return tokenizeReviewArgs(raw);
}

/** One slash command's review, or the error the person sees. */
export function commandRequest(
  name: (typeof DSH_COMMANDS)[keyof typeof DSH_COMMANDS],
  rawInput: string,
): { ok: true; kind: DshReviewKind; args: string[]; subject: string; gate: boolean } | { ok: false; error: string } {
  const raw = rawInput ?? "";
  switch (name) {
    case DSH_COMMANDS.annotate: {
      const flag = scriptOnlyAnnotateFlag(commandWords(raw));
      if (flag) return { ok: false, error: scriptOnlyAnnotateFlagText(flag) };
      const parsed = parseAnnotateArgs(raw);
      const targets = annotateTargetWords(raw);
      if (targets.length === 0) {
        return { ok: false, error: "Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--markdown]" };
      }
      const distinct = [...new Set(targets)];
      const subject = distinct.length > 1 && distinct.every(looksLikeFilePath)
        ? plannotatorBundleSubject(distinct)
        : plannotatorTargetSubject("annotate", distinct.find((word) => looksLikeFilePath(word) || /^https?:\/\//i.test(word)) ?? distinct[0]) ?? (distinct[0] as string);
      return {
        ok: true,
        kind: "annotate",
        args: [
          ...targets,
          ...(parsed.gate ? ["--gate"] : []),
          ...(parsed.renderMarkdown ? ["--markdown"] : []),
          ...(parsed.renderHtml ? ["--render-html"] : []),
          ...(parsed.noJina ? ["--no-jina"] : []),
        ],
        subject,
        gate: parsed.gate,
      };
    }
    case DSH_COMMANDS.review: {
      const words = commandWords(raw).filter((word) => word !== "--json");
      // A review's gate is the plugin's (deliver a bare approval), never passed on.
      const gate = words.includes("--gate");
      const args = words.filter((word) => word !== "--gate");
      let target: string | undefined;
      for (let index = 0; index < args.length; index++) {
        const word = args[index] as string;
        if (word === "--base" || word === "--diff-type") index++;
        else if (!word.startsWith("-")) target = target ?? word;
      }
      const subject = target ? plannotatorTargetSubject("review", target) ?? target : DSH_LOCAL_CHANGES_SUBJECT;
      return { ok: true, kind: "review", args, subject, gate };
    }
    case DSH_COMMANDS.last:
      if (raw.trim()) return { ok: false, error: "/plannotator-last takes no arguments." };
      return { ok: true, kind: "last", args: [], subject: DSH_LAST_SUBJECT, gate: false };
  }
}

/** What the plugin registers: the reviews they share, and a way to register each part in a context. */
export interface DshNative {
  readonly reviews: DshReviews;
  /** Whether the agent tool switch put the tool on (read once, at plugin load). */
  readonly toolOn: boolean;
  /** Register the `plannotator` tool in `ctx` (an `inject(['agents', 'tools'])` child). */
  registerTool(ctx: DshInboxContext): void;
  /** Register the commands in `ctx` (an `inject(['agents', 'commands'])` child). */
  registerCommands(ctx: DshInboxContext): void;
  dispose(): void;
}

/**
 * The tool and commands for this DSH process, or null in a profile that takes
 * no turns of ours. `binary` is the plugin's `binary` config, resolved for
 * each launch (`resolveBinary`).
 */
export function createDshNative(
  ctx: DshInboxContext,
  options: { resolveBinary: () => string | undefined; dataDir: string },
  deps: DshNativeDeps = {},
): DshNative | null {
  if (!profileTakesTurns(ctx)) return null;
  const warn = warnOf(ctx);
  const env = deps.env ?? process.env;
  const toolOn = resolveAgentTool(deps.config ?? loadConfig(), env, DSH_AGENT_TOOL_HOST);
  const reviews = new DshReviews({
    command: () => {
      if (deps.command) return deps.command;
      const binary = options.resolveBinary();
      return binary ? [binary] : undefined;
    },
    dataDir: options.dataDir,
    env,
    dshHome: () => dshHomeOf(ctx),
    deliver: (owner, text) => deliverTo(agentsServiceOf(ctx), owner, text),
    log: (message) => warn("plannotator: %s", message),
    ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
    ...(deps.readyWaitMs && { readyWaitMs: deps.readyWaitMs }),
  });

  // The decision and `list`/`close` belong to the top-level session; the review runs in the CALLER's
  // folder (a DSH subagent can have its own working directory, e.g. a worktree).
  const owning = (agents: DshAgentsService, agent: DshInboxAgent) => {
    const root = rootAgentOf(agents, agent);
    return { root, subagent: root !== agent, cwd: sessionCwd(ctx as DshContext, agent as never) };
  };

  const request = (root: DshInboxAgent, cwd: string | undefined, review: { kind: DshReviewKind; args: string[]; subject: string; gate: boolean }): DshReviewRequest => ({
    ...review,
    owner: root.id,
    sessionId: sessionIdOf(root),
    ...(cwd && { cwd }),
  });

  return {
    reviews,
    toolOn,
    registerTool(child) {
      if (!toolOn) return;
      const agents = agentsServiceOf(child);
      const tools = service<DshToolsService>(child, "tools");
      if (!agents || typeof tools?.register !== "function") {
        warn("plannotator: this DSH has no agents or tools service; the plannotator tool is not registered");
        return;
      }
      try {
        tools.register({
          name: PLANNOTATOR_TOOL_NAME,
          description: PLANNOTATOR_TOOL_DESCRIPTION,
          parameters: PLANNOTATOR_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
          output: {
            schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            render: (_args, value) => [{ type: "text", text: String((value as { text?: unknown } | null)?.text ?? "") }],
          },
          async execute(args, exec) {
            const caller = exec?.agent;
            if (!caller || typeof caller.id !== "string") throw new Error("plannotator: no DSH session made this call.");
            const parsed = parsePlannotatorToolInput(args);
            if (!parsed.ok) throw new Error(parsed.error);
            const call = parsed.input;
            const { root, subagent, cwd } = owning(agents, caller);
            if (call.action === "list") return { text: reviews.list(root.id) };
            if (call.action === "close") return { text: reviews.close(root.id, call.session as string) };
            if (call.action === "last" && subagent) throw new Error(DSH_SUBAGENT_LAST_TEXT);
            const gate = call.gate === true;
            const start = await reviews.open(
              request(root, cwd, { kind: call.action as DshReviewKind, args: plannotatorToolArgs(call), subject: toolSubject(call), gate }),
              exec.signal,
            );
            switch (start.state) {
              case "ready":
                return { text: plannotatorToolOpenedText(start.subject, start.url, gate, start.id, start.target) };
              case "starting":
                return { text: plannotatorToolOpenedText(start.subject, undefined, gate, start.id) };
              case "failed":
                throw new Error(dshStartFailureText(start.message));
            }
          },
        });
      } catch (error) {
        warn("plannotator: could not register the plannotator tool (%s)", error instanceof Error ? error.message : String(error));
      }
    },
    registerCommands(child) {
      const agents = agentsServiceOf(child);
      const commands = service<DshCommandsService>(child, "commands");
      if (!agents || typeof commands?.register !== "function") return;
      const define = (name: (typeof DSH_COMMANDS)[keyof typeof DSH_COMMANDS], description: string, hint?: string) => {
        try {
          commands.register({
            name,
            description,
            ...(hint && { input: { hint } }),
            async handler({ agent, rawInput, signal }) {
              const parsed = commandRequest(name, rawInput);
              if (!parsed.ok) return { kind: "error", text: parsed.error };
              if (!agent || typeof agent.id !== "string") return { kind: "error", text: "No DSH session received this command." };
              const { root, cwd } = owning(agents, agent);
              let start;
              try {
                start = await reviews.open(request(root, cwd, parsed), signal);
              } catch (error) {
                return { kind: "error", text: `Plannotator did not open: ${error instanceof Error ? error.message : String(error)}` };
              }
              switch (start.state) {
                case "ready":
                  return { kind: "success", text: `Opened ${start.subject} in Plannotator (${start.id}): ${start.url}\nYour feedback goes to the agent when you send it.` };
                case "starting":
                  return { kind: "success", text: `Plannotator is starting for ${start.subject} (${start.id}); it opens in the browser when ready.` };
                case "failed":
                  return { kind: "error", text: dshStartFailureText(start.message) };
              }
            },
          });
        } catch (error) {
          warn("plannotator: could not register /%s (%s)", name, error instanceof Error ? error.message : String(error));
        }
      };
      define(DSH_COMMANDS.review, "Review code changes or a pull request in Plannotator", "[directory | PR URL] [--base <ref>]");
      define(DSH_COMMANDS.annotate, "Annotate a file, folder or URL in Plannotator", "<file | folder | URL> [--gate] [--markdown]");
      define(DSH_COMMANDS.last, "Annotate the agent's last message in Plannotator");
    },
    dispose() {
      reviews.dispose();
    },
  };
}

/** Put a decision into a live session as a new turn; throws when it cannot. */
function deliverTo(agents: DshAgentsService | undefined, owner: string, text: string): void {
  const agent = agents?.get(owner);
  if (!agent) throw new Error("the session is not live in this DSH");
  if (typeof agent.followup !== "function") throw new Error("this DSH has no agent.followup");
  agent.followup(createUserMessage(text));
}
