export interface CommandFeedback {
  text: string;
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
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

export function createCommandTurnClient<T>(
  client: T,
  sessionID: string | undefined,
  options: {
    messageAgents?: CommandMessageAgents;
  } = {},
): {
  client: T;
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

export class CommandMessageAgents {
  private readonly agents = new Map<string, string>();

  constructor(private readonly limit = 500) {}

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

  originalOf(messageID: unknown): string | undefined {
    return typeof messageID === "string" ? this.agents.get(messageID) : undefined;
  }

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

export function appendCommandFeedback(parts: unknown[], feedback: CommandFeedback): void {
  parts.push({ type: "text", text: feedback.text });
}

export interface CommandModelRef {
  providerID: string;
  modelID: string;
}

export interface CommandAgentInfo {
  name?: string;
  mode?: string;
  hidden?: boolean;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
}

export interface FeedbackTarget {
  agent: string;
  model?: CommandModelRef;
  variant?: string;
}

function modelRef(value: unknown): CommandModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const modelID = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined;
  if (typeof value.providerID !== "string" || !value.providerID || !modelID) return undefined;
  return { providerID: value.providerID, modelID };
}

const BUILT_IN_AGENT_ORDER = ["build", "plan", "general", "explore"] as const;

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

export function resolveFeedbackTarget(input: {
  namedAgent?: string;
  agents: readonly CommandAgentInfo[];
  defaultAgent?: string;
  sessionModel?: CommandModelRef;
  modelVariants?: (model: CommandModelRef) => readonly string[] | undefined;
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

export interface PendingCommandFeedback {
  text: string;
  target: FeedbackTarget;
}

export function retargetCommandMessage(input: {
  sessionID: string;
  pending: PendingCommandFeedback;
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
