import { inboxQuestionState } from "@plannotator/core/inbox-questions";
import type { InboxMessage, InboxQuestionRecord } from "@plannotator/core/inbox-types";

export type InboxSupersedeSkipState = "answered" | "skipped" | "replaced" | "dropped" | "closed" | "marked" | "marked_sent" | "no_open_question";

export interface InboxSupersedeSkip {
  ref: string;
  id: string;
  was: InboxSupersedeSkipState;
  new_question: string | null;
}

export type InboxStoredMessage = InboxMessage & { supersede_skipped?: InboxSupersedeSkip[] };

export function inboxStoredSkips(message: InboxStoredMessage): InboxSupersedeSkip[] | undefined {
  return Array.isArray(message.supersede_skipped) ? message.supersede_skipped : undefined;
}

export function inboxSupersedeSkipState(record: InboxQuestionRecord, resolved: boolean, personMarked: boolean): InboxSupersedeSkipState {
  if (personMarked) return "marked";
  const state = inboxQuestionState(record, resolved);
  if (state === "superseded") return record.superseded_by?.key ? "replaced" : "dropped";
  if (state === "sent") return record.kind === "action" ? "marked_sent" : record.answer?.skipped === true ? "skipped" : "answered";
  return "closed";
}

const WAS_WORDS: Record<InboxSupersedeSkipState, string> = {
  answered: "was already answered",
  skipped: "was already skipped by the person",
  replaced: "was already replaced",
  dropped: "was already dropped",
  closed: "was already closed",
  marked: "was already marked by the person (their answer reaches you in a few seconds)",
  marked_sent: "was already marked by the person",
  no_open_question: "has no open question left",
};

export function inboxSupersedeSkipLine(skip: InboxSupersedeSkip): string {
  const alone = skip.new_question
    ? ` Your new ${/\/a-[0-9a-f]/.test(skip.new_question) ? "action item" : "question"} ${skip.new_question} is open on its own.`
    : "";
  return `${skip.id} ${WAS_WORDS[skip.was]}, so it was left as it is.${alone}`;
}

export function inboxSupersedeSkipsText(skips: readonly InboxSupersedeSkip[] | undefined): string {
  return (skips ?? []).map((skip) => `\n${inboxSupersedeSkipLine(skip)}`).join("");
}
