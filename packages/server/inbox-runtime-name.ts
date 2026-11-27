/**
 * The name a session's messages carry when it runs in another app than its host's own. Oh My Pi loads Plannotator's
 * Pi extension, which calls the tool as host `pi`, name "Pi"; its poll says `plugin.host: "oh-my-pi"`. A `/mcp` tool
 * call from such a session is stored under "Oh My Pi" (`inboxRuntimeAgentName`), so the thread, the phone and a linked
 * computer name it as the person started it, with nothing new on the wire. Routing never reads the name: the host
 * stays `pi`, and wake lines name an agent from its host.
 */
import { inboxRuntimeAgentName, type InboxAgentRuntime } from "@plannotator/core/inbox-types";

type ToolCall = { method?: unknown; params?: { arguments?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;

function renamed(call: unknown, runtimeOf: (session: string) => InboxAgentRuntime | undefined): ToolCall | null {
  const c = call as ToolCall | null;
  if (!c || typeof c !== "object" || c.method !== "tools/call") return null;
  const args = c.params?.arguments;
  const session = typeof args?.agent_session === "string" ? args.agent_session.trim() : "";
  if (!args || !session) return null;
  const name = inboxRuntimeAgentName(args.agent_host, args.agent_name, runtimeOf(session));
  return name ? { ...c, params: { ...c.params, arguments: { ...args, agent_name: name } } } : null;
}

/** A `/mcp` POST body (one call or a batch) with each such session's `agent_name` set to its app's; null when nothing changes. */
export function withRuntimeAgentName(body: unknown, runtimeOf: (session: string) => InboxAgentRuntime | undefined): unknown | null {
  if (Array.isArray(body)) {
    const calls = body.map((call) => renamed(call, runtimeOf));
    return calls.some(Boolean) ? body.map((call, i) => calls[i] ?? call) : null;
  }
  return renamed(body, runtimeOf);
}
