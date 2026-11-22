/**
 * Where the person wrote a message, as an agent on a linked computer reads it (a far read, inbox-far-read.ts): the
 * line (`inboxSentFromLine`) is true from the reader's side, not from this computer's. This Inbox renders the read,
 * so it moves each record to the reader's computer before the line is worded:
 *  - recorded as forwarded by the reader's own computer: that computer is "this computer" for the reader, so no line,
 *    or only where the person was when it was not that computer's own window (`via`);
 *  - written here (the person's own words with no record): this computer is the reader's linked computer, named as
 *    the reader's Inbox shows it (`shown_as` in the read's query), so the line any message forwarded by a linked
 *    computer has; with no name said (an older reader) nothing, as before;
 *  - anything else (another device over the tailnet, Cloudflare, the phone, a third computer): as it is.
 * Who the reader is comes from its door token only (the name this Inbox records for that computer); the name it says
 * for this computer is only words printed back to that same reader, cleaned as a record's name is.
 */
import { inboxSentFromName, inboxSentFromOf, isInboxNote, type InboxSentFrom } from "@plannotator/core/inbox-types";

/** The name a message forwarded by a linked computer records (inbox-sent-from.ts): this Inbox's name for it, else its device's. */
export function inboxMachineRecordName(machineName: string | null | undefined, deviceName: string | null | undefined): string {
  return inboxSentFromName(machineName ?? "") || inboxSentFromName(deviceName ?? "");
}

/** A far read's reader, as this Inbox knows it. */
export interface InboxSentFromReader {
  /** The name a message forwarded by the reader's computer records here (`inboxMachineRecordName`). Empty: none. */
  name: string;
  /** The name the reader's Inbox shows for this computer, cleaned. Empty: not said. */
  shownAs: string;
}

/** The query key a far read names this computer by, as the reader's Inbox shows it. */
export const FAR_READ_SHOWN_AS = "shown_as";

export function inboxSentFromReader(name: string, shownAs: string | null | undefined): InboxSentFromReader {
  return { name: inboxSentFromName(name), shownAs: inboxSentFromName(shownAs ?? "") };
}

type ReadMessage = {
  author: { kind: string };
  idempotency_key?: string | null;
  sent_from?: unknown;
  set_aside?: readonly string[] | null;
  reopened?: readonly string[] | null;
  ack_of?: string | null;
  tidy?: unknown;
  scheduled_run?: unknown;
};

/**
 * The person's own words, written where a record could say where (a reply, a new message, a re-ask, a thread they
 * started): never the Inbox's notes for what they did (a 👍, a set-aside, an action's report, a run's note), which
 * carry no key and never a line.
 */
function personWrote(message: ReadMessage): boolean {
  return (
    message.author.kind === "person" &&
    typeof message.idempotency_key === "string" &&
    message.idempotency_key !== "" &&
    !message.scheduled_run &&
    !isInboxNote(message as Parameters<typeof isInboxNote>[0])
  );
}

/** Where the person wrote `message`, as the reader's computer sees it. Null: the reader's own computer, or not known. */
export function inboxSentFromForReader(message: ReadMessage, reader: InboxSentFromReader): InboxSentFrom | null {
  if (message.sent_from === undefined || message.sent_from === null) {
    return reader.shownAs && personWrote(message) ? { kind: "machine", name: reader.shownAs } : null;
  }
  const from = inboxSentFromOf(message.sent_from);
  if (from?.kind === "machine" && reader.name && from.name === reader.name) return from.via ? { kind: from.via } : null;
  return from;
}

/** `message` with its record moved to the reader's side (absent when there is none), so the read words it as usual. */
export function inboxMessageForReader<M extends ReadMessage>(message: M, reader: InboxSentFromReader): M {
  const from = inboxSentFromForReader(message, reader);
  const { sent_from: _was, ...rest } = message;
  return (from ? { ...rest, sent_from: from } : rest) as M;
}
