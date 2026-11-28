import { cutText } from "./text-cut";
import { INBOX_REOPENED_HEADING, splitInboxReplyBody } from "./inbox-questions";
import { withoutInboxReplyQuoteLead } from "./inbox-reply-quote";
import { withoutInboxSkillsBlock } from "./skill-reference-block";
import type { InboxAnsweredInReplyRequest, InboxQuestionRecord } from "./inbox-types";

export const INBOX_ANSWERED_QUOTE_MAX = 500;

export const INBOX_ANSWERED_REQUESTS_MAX = 100;

export function inboxReplyOwnWords(body: string): string {
  return splitInboxReplyBody(withoutInboxReplyQuoteLead(withoutInboxSkillsBlock(body))).words;
}

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export type InboxAnsweredQuote = { ok: true; quote: string } | { ok: false; reason: string };

export function inboxAnsweredQuote(words: string, excerpt: string | undefined): InboxAnsweredQuote {
  const said = flat(words);
  if (said === "") return { ok: false, reason: "that reply has no words of the person's to quote" };
  if (excerpt === undefined) return { ok: true, quote: cutText(said, INBOX_ANSWERED_QUOTE_MAX) };
  const part = flat(excerpt);
  if (part === "") return { ok: false, reason: "quote is empty; leave it out to quote the whole reply" };
  if (!said.includes(part)) return { ok: false, reason: "quote must be an exact part of the person's reply" };
  if (part.length > INBOX_ANSWERED_QUOTE_MAX) return { ok: false, reason: `quote is over ${INBOX_ANSWERED_QUOTE_MAX} characters` };
  return { ok: true, quote: part };
}

export function normalizeInboxAnsweredRequests(value: unknown): { ok: true; requests: InboxAnsweredInReplyRequest[] } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, requests: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'a list of { "question": "<message id>/<key>", "reply"?: "<message id>", "quote"?: "<exact part of the reply>" }.' };
  if (value.length > INBOX_ANSWERED_REQUESTS_MAX) return { ok: false, reason: `at most ${INBOX_ANSWERED_REQUESTS_MAX} questions.` };
  const requests: InboxAnsweredInReplyRequest[] = [];
  for (const entry of value) {
    const item = typeof entry === "string" ? { question: entry } : entry;
    if (!item || typeof item !== "object" || typeof (item as { question?: unknown }).question !== "string") {
      return { ok: false, reason: 'each entry names its question: { "question": "<message id>/<key>" }.' };
    }
    const { question, reply, quote } = item as { question: string; reply?: unknown; quote?: unknown };
    if (reply !== undefined && reply !== null && typeof reply !== "string") return { ok: false, reason: "reply is a message id." };
    if (quote !== undefined && quote !== null && typeof quote !== "string") return { ok: false, reason: "quote is a string." };
    const request: InboxAnsweredInReplyRequest = { question: question.trim() };
    if (typeof reply === "string" && reply.trim() !== "") request.reply = reply.trim();
    if (typeof quote === "string") request.quote = quote;
    if (!requests.some((r) => r.question === request.question)) requests.push(request);
  }
  return { ok: true, requests };
}

export function composeInboxAnsweredReopenedBody(question: Pick<InboxQuestionRecord, "id" | "prompt">): string {
  return [INBOX_REOPENED_HEADING, "", `- ${question.id}: ${flat(question.prompt)}`, "", "You marked it answered in their reply; they say it is not. It is open again: don't use those words as the answer, and wait for theirs."].join("\n");
}

export const INBOX_ANSWERED_IN_REPLY_DESCRIPTION =
  'Your own open questions in this thread (read_thread state open or picked) that the person answered in their reply\'s words instead of on the card: [{"question": "<message id>/<key>"}], with "reply": its message id when it is not their newest reply, and "quote": an exact part of it when it is long. The card shows their words as the answer, and they can reopen it. Send with reply_to into the thread.';
