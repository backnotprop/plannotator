/**
 * Tag an agent on another linked computer (inbox-far-tags.ts): the tagged agent's answer, from its own computer.
 * send_message with `reply_to` a message of a thread on another computer that handed this session a wake there
 * (inbox-far-wakes.ts) goes to that computer's door (`POST agent-reply`), as this Inbox's own held write: at once
 * while it is online, and when it is back otherwise. That computer writes it as this session, with this computer
 * named. Any other far `reply_to` is refused as before (`thread_on_other_machine`, inbox-mcp.ts).
 *
 * The words and the fields about them go; what lives on this computer's disk or in that thread's state does not yet:
 * files (attachments), steps, PRs, a branch, Priority and a thread name are refused with words, nothing sent.
 */

import { randomUUID } from "node:crypto";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { OutboxEntry } from "./inbox-outbox";
import { FAR_AGENT_REPLY_ROUTE } from "./inbox-far-tags";

/** How long send_message waits for the other computer's answer while it is online. */
const FAR_REPLY_WAIT_MS = 6_000;

export interface FarReplyDeps {
  /** The far thread a wake this session was handed belongs to, by a message id or thread id of it. */
  placeOf: (id: string, session: string) => { machine: string; thread_id: string } | null;
  nameOf: (machine: string) => string | null;
  holdWrite: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number) => Promise<OutboxEntry | null> | null;
}

/** The send's fields that cannot cross to another computer's thread yet. */
const NOT_ACROSS = ["attachments", "steps", "pulls", "branch", "priority", "thread"] as const;

/**
 * The result lines (plain status, DRAFT). One place, so a change is one edit.
 */
export const FAR_REPLY_WORDS = {
  sent: (replayed: boolean, thread: string, machine: string) => `${replayed ? "Already sent" : "Sent"} to the Plannotator Inbox (thread ${thread}, on ${machine}).`,
  held: (thread: string, machine: string) => `Waiting for ${machine}: your message goes into thread ${thread} when ${machine} is back.`,
  notAcross: (fields: readonly string[], machine: string) =>
    `${fields.join(", ")}: not taken by a message into a thread on ${machine} yet. Nothing was sent; send it without ${fields.length === 1 ? "it" : "them"}.`,
};

export async function farAgentReply(
  deps: FarReplyDeps,
  input: Record<string, unknown> & { body: string; reply_to?: string; subject?: string; idempotency_key?: string; agent_session?: string; agent_name?: string },
  nextStep: () => Promise<string>,
): Promise<{ text: string; structured: Record<string, unknown> } | null> {
  const replyTo = input.reply_to?.trim();
  const session = input.agent_session?.trim();
  if (!replyTo || !session) return null;
  const place = deps.placeOf(replyTo, session);
  if (!place) return null;
  const name = deps.nameOf(place.machine) ?? "the other computer";
  const unsent = NOT_ACROSS.filter((field) => {
    const value = input[field];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) && !(typeof value === "string" && value.trim() === "");
  });
  if (unsent.length > 0) throw new InboxError("not_across_computers", FAR_REPLY_WORDS.notAcross(unsent, name));
  const key = input.idempotency_key?.trim() || `far-reply:${randomUUID()}`;
  const held = deps.holdWrite(
    place.machine,
    FAR_AGENT_REPLY_ROUTE,
    {
      idempotency_key: key,
      reply_to: replyTo,
      session,
      body: input.body,
      ...(input.agent_name ? { name: input.agent_name } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(Array.isArray(input.supersedes) ? { supersedes: input.supersedes } : {}),
      ...(Array.isArray(input.done) ? { done: input.done } : {}),
    },
    place.thread_id,
    FAR_REPLY_WAIT_MS,
  );
  if (!held) return null;
  const entry = await held;
  const machine = { id: place.machine, name };
  if (entry?.state === "delivered") {
    const answer = (entry.answer ?? {}) as { message_id?: unknown; thread_id?: unknown; replayed?: unknown };
    const thread = typeof answer.thread_id === "string" ? answer.thread_id : place.thread_id;
    return {
      text: `${FAR_REPLY_WORDS.sent(answer.replayed === true, thread, name)} ${await nextStep()}`,
      structured: { thread_id: thread, ...(typeof answer.message_id === "string" ? { message_id: answer.message_id } : {}), machine },
    };
  }
  if (entry && (entry.state === "refused" || entry.state === "dropped" || entry.state === "cancelled")) {
    const answer = (entry.answer ?? {}) as { code?: unknown; error?: unknown };
    throw new InboxError(typeof answer.code === "string" ? answer.code : "machine_refused", typeof answer.error === "string" ? answer.error : `${name} did not take the message.`);
  }
  return { text: `${FAR_REPLY_WORDS.held(place.thread_id, name)} ${await nextStep()}`, structured: { thread_id: place.thread_id, held: true, machine } };
}
