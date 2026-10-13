/**
 * OpenCode 1: deliver slash-command feedback through the command's OWN turn.
 *
 * Why this exists. OpenCode 1 runs a command as `command.execute.before`
 * (which Plannotator awaits for the whole review) followed by
 * `prompt({ parts })` on the command's own user message, and `prompt` always
 * runs the model loop: the hook has no way to say "no reply"
 * (`SessionPrompt.command`, `packages/opencode/src/session/prompt.ts` @
 * v1.18.32). Plannotator used to clear `parts` and send the feedback with a
 * separate `session.prompt`, which ran its own loop. The command's emptied
 * message then ran a SECOND loop: its user message has no content, so the
 * model saw a history ending in its own reply and answered the same feedback
 * again. Every command that returned feedback cost two model turns.
 *
 * The fix is to let the command's own message carry the feedback. While a
 * command runs, its handlers get a client whose `session.prompt` to the
 * invoking session is RECORDED instead of sent (`createCommandTurnClient`);
 * the hook then puts that text into `output.parts`, the array OpenCode turns
 * into the command's message, and OpenCode runs exactly one turn for it.
 *
 * The one thing a hook's `parts` cannot say is WHO answers: the command's
 * message takes the command's agent and model (the ones the user is on). The
 * separate prompt named the agent the feedback was for (the review UI's agent
 * switch, or the agent that wrote an annotated message, #1612) or, when there
 * was none, no agent at all, so OpenCode's default agent answered; either way
 * on that agent's configured model and variant. `resolveFeedbackTarget`
 * computes exactly that when the feedback is delivered, and
 * `retargetCommandMessage` applies it in `chat.message`, the hook OpenCode
 * fires while building the command's message (`createUserMessage`, same
 * file). Only the turn count changes.
 *
 * A command with nothing to send still runs one turn on an empty message, as
 * before; OpenCode 1 gives a command hook no way to skip it.
 *
 * OpenCode 2 never goes through here: its native commands own the invocation
 * and deliver through `createV2BridgeClient`.
 */

/** Feedback a command produced for its own turn. */
export interface CommandFeedback {
  text: string;
  /** The agent that should answer it, already validated by the handler. */
  agent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function joinText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type: string; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function bindingProxy<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      const value = Reflect.get(object, key, object);
      // SDK methods read `this` (the generated client keeps its transport on
      // the instance), so unbound access through the proxy would break them.
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * A view of `client` whose `session.prompt` to `sessionID` is recorded rather
 * than sent. Everything else (logging, toasts, listing agents and messages,
 * prompts to other sessions, `noReply` prompts) passes straight through.
 */
export function createCommandTurnClient<T>(
  client: T,
  sessionID: string | undefined,
  options: {
    /**
     * Command messages this plugin retargeted. Their `session.messages` view
     * is restored to the agent the user ran the command on; see
     * `CommandMessageAgents`.
     */
    messageAgents?: CommandMessageAgents;
  } = {},
): {
  client: T;
  /** The recorded feedback, once; undefined when nothing was recorded. */
  take: () => CommandFeedback | undefined;
} {
  const recorded: CommandFeedback[] = [];
  const take = (): CommandFeedback | undefined => {
    if (recorded.length === 0) return undefined;
    const entries = recorded.splice(0);
    const agent = entries.map((entry) => entry.agent).filter(Boolean).pop();
    return {
      text: entries.map((entry) => entry.text).join("\n\n"),
      ...(agent && { agent }),
    };
  };

  const session = isRecord(client) ? client.session : undefined;
  if (!sessionID || !isRecord(session) || typeof session.prompt !== "function") {
    return { client, take };
  }
  const send = (session.prompt as (request: unknown) => unknown).bind(session);

  const prompt = async (request: unknown) => {
    const path = isRecord(request) && isRecord(request.path) ? request.path : undefined;
    const body = isRecord(request) && isRecord(request.body) ? request.body : undefined;
    const text = joinText(body?.parts);
    if (path?.id !== sessionID || body?.noReply === true || !text.trim()) {
      return await send(request);
    }
    recorded.push({
      text,
      ...(typeof body?.agent === "string" && body.agent ? { agent: body.agent } : {}),
    });
    return { data: undefined };
  };

  const overrides: Record<PropertyKey, unknown> = { prompt };
  const messageAgents = options.messageAgents;
  if (messageAgents && typeof session.messages === "function") {
    const list = (session.messages as (request: unknown) => unknown).bind(session);
    overrides.messages = async (request: unknown) => messageAgents.restore(await list(request));
  }

  return {
    client: bindingProxy(client as object, {
      session: bindingProxy(session, overrides),
    }) as T,
    take,
  };
}

/**
 * The agent each retargeted command message was BUILT with: the agent the user
 * ran the command on.
 *
 * Why it matters. The command handlers read "the agent the user is talking
 * to" as the agent of the session's last user message (`readLastUserAgent`,
 * #1612). Up to 0.28.0 that message, right after a Plannotator command, was
 * the command's own emptied message, which kept the user's agent. Since the
 * feedback rides that message and `retargetCommandMessage` points it at the
 * feedback's agent, a follow-up `/plannotator-annotate` would read the
 * PREVIOUS feedback's agent instead: after a review sent from `plan` with no
 * switch, the default `build` agent, which may edit files. So the handlers'
 * view of `session.messages` reports each retargeted message under the agent
 * it was built with, exactly what 0.28.0 read there. The model and OpenCode
 * itself still see the real (retargeted) message.
 *
 * In memory and bounded: after the plugin restarts, a message retargeted
 * before reads as its stored agent.
 */
export class CommandMessageAgents {
  private readonly agents = new Map<string, string>();

  constructor(private readonly limit = 500) {}

  /** Remember `originalAgent` for a message that now carries another agent. */
  record(messageID: unknown, originalAgent: unknown, currentAgent: unknown): void {
    if (typeof messageID !== "string" || !messageID) return;
    if (typeof originalAgent !== "string" || !originalAgent || originalAgent === currentAgent) return;
    this.agents.delete(messageID);
    this.agents.set(messageID, originalAgent);
    while (this.agents.size > this.limit) {
      const oldest = this.agents.keys().next().value;
      if (oldest === undefined) break;
      this.agents.delete(oldest);
    }
  }

  /** The agent the message was built with, when this plugin retargeted it. */
  originalOf(messageID: unknown): string | undefined {
    return typeof messageID === "string" ? this.agents.get(messageID) : undefined;
  }

  /**
   * A `session.messages` response with retargeted user messages reported under
   * their original agent. Copies what it changes; never mutates the response.
   */
  restore(response: unknown): unknown {
    if (this.agents.size === 0 || !isRecord(response) || !Array.isArray(response.data)) return response;
    let changed = false;
    const data = response.data.map((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.info) || entry.info.role !== "user") return entry;
      const original = this.originalOf(entry.info.id);
      if (!original) return entry;
      changed = true;
      return { ...entry, info: { ...entry.info, agent: original } };
    });
    return changed ? { ...response, data } : response;
  }
}

/** Put the recorded feedback into the command's own message. */
export function appendCommandFeedback(parts: unknown[], feedback: CommandFeedback): void {
  parts.push({ type: "text", text: feedback.text });
}

/** A model reference as OpenCode 1 user messages carry it. */
export interface CommandModelRef {
  providerID: string;
  modelID: string;
}

/** An OpenCode 1 agent listing entry (`GET /agent`), as far as routing reads it. */
export interface CommandAgentInfo {
  name?: string;
  mode?: string;
  hidden?: boolean;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
}

/** Who answers the feedback, on which model and variant. */
export interface FeedbackTarget {
  agent: string;
  /** Undefined when the host could not say; the message keeps its model then. */
  model?: CommandModelRef;
  variant?: string;
}

function modelRef(value: unknown): CommandModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const modelID = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined;
  if (typeof value.providerID !== "string" || !value.providerID || !modelID) return undefined;
  return { providerID: value.providerID, modelID };
}

/**
 * The order OpenCode registers its built-in agents in (`Agent.state`), which is
 * the order `Agent.defaultInfo()` / `defaultAgent()` walk with
 * `Object.values(agents).find(...)`. Config agents come after them; a config
 * entry for a built-in name edits it in place and keeps its position.
 */
const BUILT_IN_AGENT_ORDER = ["build", "plan", "general", "explore"] as const;

/**
 * How `createUserMessage` picked the variant of a prompt that named none,
 * by OpenCode version (scanned over every v1.x tag of anomalyco/opencode):
 *  - before 1.1.49: never (`variant: input.variant`);
 *  - 1.1.49 to 1.1.53: the agent's variant when the message's model is the
 *    agent's own configured one, with NO check that the model offers it
 *    ("agent-model-unchecked");
 *  - 1.1.54 to 1.3.13: the agent's variant when the message's model offers it,
 *    whichever model that is ("offered");
 *  - 1.3.14 on: offered AND on the agent's own model (`&& same`,
 *    "agent-model").
 * An unknown or unparsable version takes the current rule.
 */
export type AgentVariantRule = "none" | "agent-model-unchecked" | "offered" | "agent-model";

export function agentVariantRule(hostVersion: string | undefined): AgentVariantRule {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(hostVersion ?? "");
  if (!match) return "agent-model";
  const [major, minor, patch] = match.slice(1).map(Number);
  const before = (a: number, b: number, c: number) =>
    major < a || (major === a && (minor < b || (minor === b && patch < c)));
  if (major !== 1) return "agent-model";
  if (before(1, 1, 49)) return "none";
  if (before(1, 1, 54)) return "agent-model-unchecked";
  if (before(1, 3, 14)) return "offered";
  return "agent-model";
}

/**
 * Resolve what OpenCode 1 would have used for a prompt naming `namedAgent`
 * (or no agent) with no model and no variant: the shape of every feedback
 * prompt this plugin used to send. Mirrors `createUserMessage`
 * (`packages/opencode/src/session/prompt.ts`):
 *
 *  - agent: the named one, else `default_agent` from config, else the first
 *    primary, non-hidden agent in OpenCode's own order: the built-ins first
 *    (`BUILT_IN_AGENT_ORDER`), then the listing's order. `GET /agent` sorts
 *    differently (default/`build` first, then by name), which matters when
 *    `build` is disabled or hidden;
 *  - model: `agent.model ?? currentModel(session)` (`lastModel` before 1.18),
 *    the session's stored model, else the last user message's;
 *  - variant: per `agentVariantRule(hostVersion)`; where the rule checks that
 *    the model offers it (`full?.variants?.[agent.variant]`), `modelVariants`
 *    answers that, and undefined there means the host could not list models,
 *    so the agent's own configured variant is kept.
 *
 * Returns undefined when the agent cannot be resolved, in which case the
 * command's message is left exactly as OpenCode built it.
 */
export function resolveFeedbackTarget(input: {
  namedAgent?: string;
  agents: readonly CommandAgentInfo[];
  /** `default_agent` from the OpenCode config, when set. */
  defaultAgent?: string;
  /** The session's current model before the command's message was created. */
  sessionModel?: CommandModelRef;
  modelVariants?: (model: CommandModelRef) => readonly string[] | undefined;
  /**
   * The OpenCode version, from the session's own `version` (see
   * `resolveCommandFeedbackTarget` in index.ts for why not the running host's).
   */
  hostVersion?: string;
}): FeedbackTarget | undefined {
  let agent: CommandAgentInfo | undefined;
  if (input.namedAgent) {
    agent = input.agents.find((entry) => entry.name === input.namedAgent);
  } else if (input.defaultAgent) {
    agent = input.agents.find((entry) => entry.name === input.defaultAgent);
  } else {
    const visible = input.agents.filter((entry) => entry.mode !== "subagent" && entry.hidden !== true);
    agent = BUILT_IN_AGENT_ORDER.map((name) => visible.find((entry) => entry.name === name)).find(Boolean)
      ?? visible[0];
  }
  if (!agent?.name) return undefined;

  const agentModel = modelRef(agent.model);
  const model = agentModel ?? input.sessionModel;
  const rule = agentVariantRule(input.hostVersion);
  let variant: string | undefined;
  if (rule === "agent-model-unchecked") {
    variant = agentModel ? agent.variant : undefined;
  } else {
    // The model the variant is checked against: the agent's own under the
    // current rule, whichever model the message gets under "offered".
    const variantModel = rule === "agent-model" ? agentModel : rule === "offered" ? model : undefined;
    if (variantModel && agent.variant) {
      const offered = input.modelVariants?.(variantModel);
      variant = offered === undefined || offered.includes(agent.variant) ? agent.variant : undefined;
    }
  }
  return {
    agent: agent.name,
    ...(model && { model }),
    ...(variant && { variant }),
  };
}

/** Feedback waiting for its message, with the target resolved at delivery time. */
export interface PendingCommandFeedback {
  text: string;
  target: FeedbackTarget;
}

/**
 * Give the command's message the agent, model and variant the feedback prompt
 * would have had (`resolveFeedbackTarget`), so moving the feedback into the
 * command's own turn changes nothing but the number of turns.
 *
 * Where the variant lives depends on the OpenCode version: up to 1.3.x a user
 * message carries it top-level (`info.variant`, set from the command's
 * `input.variant`, i.e. the TUI pick, and read from there by the request);
 * 1.18 moved it into `info.model.variant`. A message that has its own
 * `variant` key is the older shape, and that key is what gets replaced.
 *
 * Applies only to the message that carries `pending.text` in `sessionID`, so
 * an unrelated prompt can never be retargeted. Returns whether it applied.
 */
export function retargetCommandMessage(input: {
  sessionID: string;
  pending: PendingCommandFeedback;
  /** `chat.message`'s own input. */
  hook: { sessionID?: unknown };
  message: unknown;
  parts: unknown;
}): boolean {
  if (input.hook.sessionID !== input.sessionID || !isRecord(input.message)) return false;
  if (!Array.isArray(input.parts) || !input.parts.some((part) =>
    isRecord(part) && part.type === "text" && part.text === input.pending.text)) return false;

  const { target } = input.pending;
  const message = input.message;
  const topLevelVariant = Object.prototype.hasOwnProperty.call(message, "variant");
  const model = target.model ?? modelRef(message.model);
  message.agent = target.agent;
  if (model) {
    message.model = {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(!topLevelVariant && target.variant && { variant: target.variant }),
    };
  }
  if (topLevelVariant) {
    if (target.variant) message.variant = target.variant;
    else delete message.variant;
  }
  return true;
}
