/**
 * Where the person wrote a message, as an agent on a linked computer reads it (a far read, inbox-far-read.ts): the
 * line (`inboxSentFromLine`) is true from the reader's side, not from this computer's. This Inbox renders the read,
 * so it moves each record to the reader's computer before the line is worded:
 *  - recorded as forwarded by the reader's own computer: that computer is "this computer" for the reader, so no line,
 *    or only where the person was when it was not that computer's own window (`via`);
 *  - `here` (this computer's own window): this computer is the reader's linked computer, named as the reader's Inbox
 *    shows it (`shown_as` in the read's query), so the line any message forwarded by a linked computer has; with no
 *    name said (an older reader) nothing;
 *  - no record (a program's write, a note the Inbox writes, a message older than the records): nothing, as before;
 *  - anything else (another device over the tailnet, Cloudflare, the phone, a third computer): as it is.
 * Who the reader is comes from its door token only (the name this Inbox records for that computer, and none when
 * another linked computer records the same name); the name it says for this computer is only words printed back to
 * that same reader, cleaned as a record's name is.
 */
import { inboxSentFromName, inboxSentFromOf, type InboxSentFrom } from "@plannotator/core/inbox-types";

/** The name a message forwarded by a linked computer records (inbox-sent-from.ts): this Inbox's name for it, else its device's. */
export function inboxMachineRecordName(machineName: string | null | undefined, deviceName: string | null | undefined): string {
  return inboxSentFromName(machineName ?? "") || inboxSentFromName(deviceName ?? "");
}

/**
 * The reader's name for matching its own forwards: `own`, or none when another linked computer records the same name
 * (`others`), so neither one's forward is taken for the reader's own computer: each reads as "their linked computer".
 * A forward records a name only, never which link it came by, so the name is all a read can match.
 */
export function inboxFarReaderName(own: string, others: readonly string[]): string {
  return own && !others.includes(own) ? own : "";
}

/** A far read's reader, as this Inbox knows it. */
export interface InboxSentFromReader {
  /** The name a message forwarded by the reader's computer records here (`inboxFarReaderName`). Empty: none known. */
  name: string;
  /** The name the reader's Inbox shows for this computer, cleaned. Empty: not said. */
  shownAs: string;
}

/** The query key a far read names this computer by, as the reader's Inbox shows it. */
export const FAR_READ_SHOWN_AS = "shown_as";

export function inboxSentFromReader(name: string, shownAs: string | null | undefined): InboxSentFromReader {
  return { name: inboxSentFromName(name), shownAs: inboxSentFromName(shownAs ?? "") };
}

/** Where the person wrote a message, as the reader's computer sees it. Null: the reader's own computer, or not known. */
export function inboxSentFromForReader(message: { sent_from?: unknown }, reader: InboxSentFromReader): InboxSentFrom | null {
  const from = inboxSentFromOf(message.sent_from);
  if (!from) return null;
  if (from.kind === "here") return reader.shownAs ? { kind: "machine", name: reader.shownAs } : null;
  if (from.kind === "machine" && reader.name && from.name === reader.name) return from.via ? { kind: from.via } : null;
  return from;
}

/** `message` with its record moved to the reader's side (absent when there is none), so the read words it as usual. */
export function inboxMessageForReader<M extends { sent_from?: unknown }>(message: M, reader: InboxSentFromReader): M {
  const from = inboxSentFromForReader(message, reader);
  const { sent_from: _was, ...rest } = message;
  return (from ? { ...rest, sent_from: from } : rest) as M;
}
