/**
 * Which OpenCode agent should answer Plannotator annotate feedback (#1612).
 *
 * A prompt delivered WITHOUT an `agent` is not "the session's agent" on
 * OpenCode 1: `SessionPrompt.createUserMessage` resolves
 * `input.agent ? agents.get(input.agent) : agents.defaultInfo()` and then
 * records that agent as the session's current one (`sessions.setAgentModel`),
 * so feedback on a message written by a custom agent was answered by the
 * configured `default_agent` (usually `build`), which then stuck. Naming the
 * agent explicitly is exactly what the TUI does for a normal user message, so
 * it carries no extra side effect beyond what typing to that agent would.
 *
 * On OpenCode 2 there is no per-prompt agent; the V2 bridge client turns the
 * `agent` field into `session.switchAgent`, skipping it when the session is
 * already on that agent.
 */

export interface AgentTaggedMessage {
  messageId: string;
  /** The agent that wrote the message, when the host recorded one. */
  agent?: string;
}

export interface AnnotateMessageSelection {
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
}

/** The `agent` a host message records, when it is a non-empty string. */
export function readMessageAgent(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const agent = (info as { agent?: unknown }).agent;
  return typeof agent === "string" && agent.trim() ? agent.trim() : undefined;
}

/**
 * The agent that wrote the annotated message, or undefined when that is not
 * known — in which case the caller sends no agent, exactly as before.
 *
 * - A single selected message (the picker's choice) names its own agent.
 * - Without a usable selection (one candidate and no picker, a multi-message
 *   submission, an older binary that omits the id on approval) the target is
 *   known only when every candidate message was written by the same agent.
 */
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

/**
 * The agent of the session's most recent user message: the closest thing
 * OpenCode 1 exposes to "the agent the user is talking to" from inside a
 * command hook, whose input carries no agent.
 */
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

/**
 * Keep `agent` only when the host still lists it as a selectable primary agent.
 *
 * OpenCode 1 REJECTS a prompt naming an unknown agent ("Agent not found"),
 * which would cost the reviewer their feedback, and a message can outlive its
 * agent's config. Hidden agents (`compaction`, `title`, `summary`) write
 * messages too but must never be addressed, and a subagent is not a session's
 * primary agent. Anything uncertain, including a failed listing, falls back to
 * sending no agent: today's behavior. Silent by design, apart from a log line:
 * nothing here was configured by the user, so there is nothing to warn about.
 */
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
    // Fall through: omit rather than risk a rejected prompt.
  }
  try {
    void input.client.app?.log?.({
      level: "info",
      message: `[Plannotator] OpenCode agent "${agent}" is not addressable; delivering feedback without naming an agent.`,
    });
  } catch {
    // Logging is best-effort.
  }
  return undefined;
}
