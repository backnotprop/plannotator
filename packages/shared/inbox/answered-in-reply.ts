import { inboxAnsweredQuote, inboxReplyOwnWords } from "@plannotator/core/inbox-answered-in-reply";
import { inboxQuestionState, isInboxQuestionSupersedable, parseInboxSupersedeRef } from "@plannotator/core/inbox-questions";
import { isInboxNote, type InboxAnsweredInReply, type InboxAnsweredInReplyRequest, type InboxAuthor, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export interface InboxAnsweredView {
  message: (id: string) => InboxMessage | undefined;
  threadMessages: (threadId: string) => readonly InboxMessage[];
  questionRecords: (messageId: string) => readonly InboxQuestionRecord[];
  closedByArchive: (message: InboxMessage) => boolean;
  openQuestionsOf: (threadId: string | null) => { id: string; prompt: string }[];
}

const isPersonWords = (message: InboxMessage): boolean =>
  message.author.kind === "person" && !isInboxNote(message) && (message.reask?.length ?? 0) === 0;

function replyFor(view: InboxAnsweredView, members: readonly InboxMessage[], asked: InboxMessage, named: string | undefined): InboxMessage | string {
  const after = members.slice(members.findIndex((m) => m.id === asked.id) + 1);
  if (named === undefined) return after.filter(isPersonWords).at(-1) ?? "the person has not replied after it";
  const reply = view.message(named);
  if (!reply || reply.thread_id !== asked.thread_id) return `reply ${named} is not a message of this thread`;
  if (!isPersonWords(reply)) return `reply ${named} is not the person's own reply`;
  if (!after.some((m) => m.id === reply.id)) return `reply ${named} came before the question`;
  return reply;
}

export function planInboxAnsweredInReply(
  view: InboxAnsweredView,
  threadId: string | null,
  requests: readonly InboxAnsweredInReplyRequest[],
  author: Extract<InboxAuthor, { kind: "agent" }>,
  superseding: ReadonlySet<string>,
  messageId: string,
  at: string,
): Map<string, InboxAnsweredInReply> {
  const plan = new Map<string, InboxAnsweredInReply>();
  if (requests.length === 0) return plan;
  const problems: string[] = [];
  const members = threadId === null ? [] : view.threadMessages(threadId);
  for (const request of requests) {
    const ref = request.question;
    const target = parseInboxSupersedeRef(ref);
    if (!target || target.key === null || !target.key.startsWith("q-")) {
      problems.push(`"${ref}" is not a question's id: write <message id>/<key> (read_thread gives the key).`);
      continue;
    }
    const asked = view.message(target.message_id);
    if (!asked || asked.author.kind !== "agent") {
      problems.push(`${ref}: no agent message ${target.message_id}.`);
      continue;
    }
    if (threadId === null || asked.thread_id !== threadId) {
      problems.push(`${ref} is in another thread (${asked.thread_id}): send with reply_to ${target.message_id}.`);
      continue;
    }
    if ((asked.author.session ?? null) !== (author.session ?? null) || (asked.author.host ?? null) !== (author.host ?? null)) {
      problems.push(`${ref}: another session asked it; only the agent that asked a question may mark it answered.`);
      continue;
    }
    const record = view.questionRecords(asked.id).find((r) => r.key === target.key && r.kind !== "action");
    if (!record) {
      problems.push(`${ref}: message ${target.message_id} has no question ${target.key}.`);
      continue;
    }
    const state = inboxQuestionState(record, view.closedByArchive(asked));
    if (!isInboxQuestionSupersedable(state)) {
      problems.push(`${ref} is not open (it is ${state}).`);
      continue;
    }
    if (superseding.has(record.id)) {
      problems.push(`${ref} is also in supersedes; name it in one of them.`);
      continue;
    }
    const reply = replyFor(view, members, asked, request.reply);
    if (typeof reply === "string") {
      problems.push(`${ref}: ${reply}.`);
      continue;
    }
    const quoted = inboxAnsweredQuote(inboxReplyOwnWords(reply.body), request.quote);
    if (!quoted.ok) {
      problems.push(`${ref}: ${quoted.reason} (${reply.id}).`);
      continue;
    }
    plan.set(record.id, { reply_id: reply.id, quote: quoted.quote, message_id: messageId, at });
  }
  if (problems.length > 0) {
    const open = view.openQuestionsOf(threadId).filter((q) => /\/q-/.test(q.id));
    const listing = open.length > 0 ? `Open questions in this thread: ${open.map((q) => `${q.id} (${q.prompt})`).join("; ")}.` : "This thread has no open questions.";
    throw new InboxError("invalid_answered_in_reply", `answered_in_reply: ${problems.join(" ")} Nothing was sent. ${listing}`, { field: "answered_in_reply", open_questions: open });
  }
  return plan;
}
