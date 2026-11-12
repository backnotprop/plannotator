export interface AgentTaggedMessage {
  messageId: string;
  agent?: string;
}

export interface AnnotateMessageSelection {
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
}

export function readMessageAgent(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const agent = (info as { agent?: unknown }).agent;
  return typeof agent === "string" && agent.trim() ? agent.trim() : undefined;
}

export function resolveAnnotatedMessageAgent(
  messages: readonly AgentTaggedMessage[],
  selection: AnnotateMessageSelection,
): string | undefined {
  if (selection.selectedMessageId && selection.feedbackScope !== "messages") {
    const selected = messages.find((message) => message.messageId === selection.selectedMessageId);
    if (selected) return selected.agent;
  }

  if (messages.length === 0) return undefined;
  const first = messages[0].agent;
  if (!first) return undefined;
  return messages.every((message) => message.agent === first) ? first : undefined;
}

export function readLastUserAgent(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = (messages[i] as { info?: { role?: unknown } } | undefined)?.info;
    if (info?.role !== "user") continue;
    const agent = readMessageAgent(info);
    if (agent) return agent;
  }
  return undefined;
}

interface AgentListingClient {
  app?: {
    agents?: (input?: unknown) => Promise<{ data?: Array<{ name?: string; mode?: string; hidden?: boolean }> }>;
    log?: (entry: { level: "info" | "error"; message: string }) => unknown;
  };
}

export async function resolveAddressableAgent(input: {
  client: AgentListingClient;
  agent?: string;
  directory?: string;
}): Promise<string | undefined> {
  const agent = input.agent?.trim();
  if (!agent) return undefined;
  try {
    const response = await input.client.app?.agents?.({ query: { directory: input.directory } });
    const match = (response?.data ?? []).find((entry) => entry?.name === agent);
    if (match && match.hidden !== true && match.mode !== "subagent") return agent;
  } catch {
  }
  try {
    void input.client.app?.log?.({
      level: "info",
      message: `[Plannotator] OpenCode agent "${agent}" is not addressable; delivering feedback without naming an agent.`,
    });
  } catch {
  }
  return undefined;
}
