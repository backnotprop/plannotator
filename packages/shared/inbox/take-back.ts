import { isInboxNote, type InboxMessage } from "@plannotator/core/inbox-types";

export interface InboxHolder {
  by: "delivered" | "read" | "handed" | "handing";
  session: string | null;
  host: string | null;
}

export function inboxTakeBackRefusal(message: InboxMessage, facts: { carries: boolean; loneRoot: boolean }): string | null {
  if (message.author.kind !== "person" || isInboxNote(message) || (message.reask?.length ?? 0) > 0) return "Only your own reply or message can be taken back.";
  if (message.launch) return "The first message of a session started from the Inbox can't be taken back.";
  if (message.handoff || message.review_verdict || message.guide || facts.carries) return "Only a message of words and files can be taken back.";
  if (message.id === message.thread_id && !facts.loneRoot) return "Take back the later messages of this thread first.";
  return null;
}
