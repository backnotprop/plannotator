import { hasInboxReplyOwnWords, inboxAnsweredQuote, inboxReplyOwnWords } from "./answered-words";
import { inboxQuestionState, isInboxQuestionSupersedable, parseInboxSupersedeRef } from "@plannotator/core/inbox-questions";
import { isInboxNote, type InboxAnsweredInReply, type InboxAnsweredInReplyRequest, type InboxAuthor, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export interface InboxAnsweredView {
  message: (id: string) => InboxMessage | undefined;
  threadMessages: (threadId: string) => readonly InboxMessage[];
  questionRecords: (messageId: string) => readonly InboxQuestionRecord[];
  closedByArchive: (message: InboxMessage) => boolean;
  openQuestionsOf: (threadId: string | null) => { id: string; prompt: string }[];
  /** The reply went to `session` (addressed to it, not only to another agent). */
  sentTo: (message: InboxMessage, session: string) => boolean;
  /** The reply went to `session` and that session got it or read it. */
  reachedSession: (message: InboxMessage, session: string) => boolean;
}

type AgentAuthor = Extract<InboxAuthor, { kind: "agent" }>;

const isPersonWords = (message: InboxMessage): boolean =>
  message.author.kind === "person" && !isInboxNote(message) && (message.reask?.length ?? 0) === 0 && !message.taken_back_at;

const sameAgent = (a: AgentAuthor, b: AgentAuthor): boolean =>
  a.session !== null && a.session === b.session && (a.host ?? null) === (b.host ?? null) && (a.machine ?? null) === (b.machine ?? null);

type ReplyPick = { reply: InboxMessage; quote: string } | string;

function quoteFrom(reply: InboxMessage, excerpt: string | undefined): ReplyPick {
  const quoted = inboxAnsweredQuote(inboxReplyOwnWords(reply.body), excerpt);
  return quoted.ok ? { reply, quote: quoted.quote } : `${quoted.reason} (${reply.id})`;
}

function replyFor(view: InboxAnsweredView, members: readonly InboxMessage[], asked: InboxMessage, record: InboxQuestionRecord, session: string, request: InboxAnsweredInReplyRequest, replyTo: string | null): ReplyPick {
  const named = request.reply ?? undefined;
  const after = members.slice(members.findIndex((m) => m.id === asked.id) + 1);
  const reopenedAt = after.reduce((last, m, i) => (m.reopened?.includes(record.id) ? i : last), -1);
  const since = after.slice(reopenedAt + 1).filter((m) => isPersonWords(m) && hasInboxReplyOwnWords(m.body));
  const usable = since.filter((m) => view.reachedSession(m, session));
  const notReached = (reply: InboxMessage) =>
    view.sentTo(reply, session) ? `reply ${reply.id} has not reached you yet: read the thread (read_thread with your agent_session) and send again` : `reply ${reply.id} was sent to another agent, not to you`;
  const holding = request.quote === undefined ? undefined : since.find((m) => !usable.includes(m) && typeof quoteFrom(m, request.quote) !== "string");
  let pick: ReplyPick;
  if (named === undefined) {
    if (usable.length === 0) {
      if (holding) return notReached(holding);
      return reopenedAt >= 0
        ? "the person reopened it and no reply of theirs to you has reached you since: read the thread (read_thread with your agent_session) and send again"
        : "no reply of the person's to you has reached you after it: read the thread (read_thread with your agent_session) and send again";
    }
    if (usable.length === 1) pick = quoteFrom(usable[0]!, request.quote);
    else if (request.quote === undefined) return `${usable.length} replies of the person's reached you after it (${usable.map((m) => m.id).join(", ")}); give "quote" with their exact words, or name the reply with "reply"`;
    else {
      const first = usable.find((m) => m.id === replyTo) ?? usable.at(-1)!;
      const order = [first, ...usable.filter((m) => m !== first).reverse()];
      pick = order.map((m) => quoteFrom(m, request.quote)).find((p) => typeof p !== "string") ?? quoteFrom(first, request.quote);
    }
    if (typeof pick === "string" && holding) return notReached(holding);
  } else {
    const reply = view.message(named);
    if (!reply || reply.thread_id !== asked.thread_id) return `reply ${named} is not a message of this thread`;
    if (!isPersonWords(reply)) return `reply ${named} is not the person's own reply`;
    if (!hasInboxReplyOwnWords(reply.body)) return `reply ${named} has no words the person wrote`;
    if (!after.some((m) => m.id === reply.id)) return `reply ${named} came before the question`;
    if (after.findIndex((m) => m.id === reply.id) < reopenedAt) return `the person reopened it after reply ${named}`;
    if (!view.reachedSession(reply, session)) return notReached(reply);
    pick = quoteFrom(reply, request.quote);
  }
  if (typeof pick !== "string" && record.picked_at && record.picked_at > pick.reply.created_at) return `the person picked on the card after reply ${pick.reply.id}`;
  return pick;
}

export interface InboxAnsweredPlan {
  marks: Map<string, InboxAnsweredInReply>;
  /** Left out of a send from another computer (checked only when it arrived), each with why. */
  skipped: { question: string; reason: string }[];
}

/**
 * The questions a send marks answered in the person's reply. A send from this computer is refused whole on any
 * problem; one from a linked computer (`author.machine`, which may have waited in its outbox) skips the entries
 * that no longer hold and is delivered, the skipped ones listed.
 */
export function planInboxAnsweredInReply(
  view: InboxAnsweredView,
  threadId: string | null,
  requests: readonly InboxAnsweredInReplyRequest[],
  author: AgentAuthor,
  superseding: ReadonlySet<string>,
  messageId: string,
  at: string,
  replyTo: string | null,
): InboxAnsweredPlan {
  const plan: InboxAnsweredPlan = { marks: new Map(), skipped: [] };
  if (requests.length === 0) return plan;
  const problems: { question: string; reason: string }[] = [];
  const members = threadId === null ? [] : view.threadMessages(threadId);
  for (const request of requests) {
    const ref = request.question;
    const refuse = (reason: string) => problems.push({ question: ref, reason });
    const target = parseInboxSupersedeRef(ref);
    if (!target || target.key === null || !target.key.startsWith("q-")) {
      refuse(`"${ref}" is not a question's id: write <message id>/<key> (read_thread gives the key).`);
      continue;
    }
    const asked = view.message(target.message_id);
    if (!asked || asked.author.kind !== "agent") {
      refuse(`${ref}: no agent message ${target.message_id}.`);
      continue;
    }
    if (threadId === null) {
      refuse(`${ref}: send with reply_to ${target.message_id}, into the question's thread.`);
      continue;
    }
    if (asked.thread_id !== threadId) {
      refuse(`${ref} is in another thread (${asked.thread_id}): send with reply_to ${target.message_id}.`);
      continue;
    }
    if (asked.author.session === null) {
      refuse(`${ref} was asked without agent_session, so no agent can mark it answered; it stays open for the person.`);
      continue;
    }
    if (author.session === null) {
      refuse(`${ref}: send with agent_session (your session id); only the session that asked a question may mark it answered.`);
      continue;
    }
    if (!sameAgent(asked.author, author)) {
      refuse(`${ref}: another session asked it; only the agent that asked a question may mark it answered.`);
      continue;
    }
    const record = view.questionRecords(asked.id).find((r) => r.key === target.key && r.kind !== "action");
    if (!record) {
      refuse(`${ref}: message ${target.message_id} has no question ${target.key}.`);
      continue;
    }
    const state = inboxQuestionState(record, view.closedByArchive(asked));
    if (!isInboxQuestionSupersedable(state)) {
      refuse(`${ref} is not open (it is ${state}).`);
      continue;
    }
    if (superseding.has(record.id)) {
      refuse(`${ref} is also in supersedes; name it in one of them.`);
      continue;
    }
    const pick = replyFor(view, members, asked, record, author.session, request, replyTo);
    if (typeof pick === "string") {
      refuse(`${ref}: ${pick}.`);
      continue;
    }
    plan.marks.set(record.id, { reply_id: pick.reply.id, quote: pick.quote, message_id: messageId, at });
  }
  if (problems.length === 0) return plan;
  if (author.machine) return { ...plan, skipped: problems };
  const open = view.openQuestionsOf(threadId).filter((q) => /\/q-/.test(q.id));
  const listing = open.length > 0 ? `Open questions in this thread: ${open.map((q) => `${q.id} (${q.prompt})`).join("; ")}.` : "This thread has no open questions.";
  throw new InboxError("invalid_answered_in_reply", `answered_in_reply: ${problems.map((p) => p.reason).join(" ")} Nothing was sent. ${listing}`, { field: "answered_in_reply", open_questions: open });
}
