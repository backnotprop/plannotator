/**
 * Swarm mode: the block a swarm thread's first message carries for each agent it goes to (`inboxSwarmStartBlock`,
 * ./swarm-words), after its words, in the wake (./uploads `inboxBodyForAgent`) and in read_thread. Only on the root
 * of a thread the person sent with New message's Swarm badge on (`InboxMessage.swarm`).
 */

import { inboxAgentName } from "@plannotator/core/inbox-types";
import { inboxSwarmStartBlock } from "./swarm-words";

interface Addressee {
  host: string | null;
  session: string;
}

/**
 * The block for `reader` (a session; the root's other agents are named by their host's name), or "" when the message
 * is no swarm root. With no reader known, every agent the root goes to is named.
 */
export function inboxSwarmStartFor(
  message: { id?: string; thread_id?: string; swarm?: true; to?: Addressee | null; tags?: readonly Addressee[] | null },
  reader: string | null = null,
): string {
  if (message.swarm !== true || !message.thread_id || (message.id !== undefined && message.id !== message.thread_id)) return "";
  const agents = [...(message.to ? [message.to] : []), ...(message.tags ?? [])];
  const others = agents.filter((agent) => !reader || agent.session !== reader).map((agent) => inboxAgentName({ kind: "agent", host: agent.host }));
  return inboxSwarmStartBlock(message.thread_id, others);
}
