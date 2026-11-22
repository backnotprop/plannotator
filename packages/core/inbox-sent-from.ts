/**
 * Where the person wrote a message, as the Inbox that accepted it could tell from the request itself (never from what
 * the page says): another device over the tailnet, through Cloudflare Access, the Plannotator phone app, or a linked
 * computer (named as the Inbox names it), which may say it came to it from one of the first three. This computer's own
 * window records `here`, which no agent here is ever shown: only an agent on a linked computer reading the thread is
 * told it was written on this one (inbox-sent-from-reader.ts in the server). Anything the Inbox cannot tell (a
 * program, an older Inbox's message, a note the Inbox writes) records nothing.
 * The agent reads it as one line under the person's words (`inboxSentFromLine`); the window draws nothing.
 */

/** Where the person was, on a device other than the Inbox's computer. */
export type InboxSentFromPlace = "tailnet" | "cloudflare" | "phone";

export type InboxSentFrom =
  | { kind: InboxSentFromPlace }
  /** This computer's own window. Never a line here: a linked computer's agent reading the thread reads it as written on this one. */
  | { kind: "here" }
  /** Forwarded by a linked computer: its name here, and where the person was when it was not that computer's own window. */
  | { kind: "machine"; name: string; via?: InboxSentFromPlace };

/** The header a linked computer's Inbox sends with a forwarded write when the person was not at its own window. */
export const INBOX_SENT_FROM_HEADER = "X-Plannotator-Sent-From";

const PLACES: readonly InboxSentFromPlace[] = ["tailnet", "cloudflare", "phone"];
const NAME_MAX = 64;

export function isInboxSentFromPlace(value: unknown): value is InboxSentFromPlace {
  return typeof value === "string" && (PLACES as readonly string[]).includes(value);
}

/** `INBOX_SENT_FROM_HEADER` as the door reads it: one of the places, else null. The door believes it from a linked computer only. */
export function inboxSentFromPlaceOf(header: string | null | undefined): InboxSentFromPlace | null {
  const value = header?.trim().toLowerCase() ?? "";
  return isInboxSentFromPlace(value) ? value : null;
}

/**
 * A machine's name for the line: one line, no controls, no backtick, at most 64 characters, cut between whole
 * characters as a person sees them (an emoji is never split). Empty when nothing is left. The server cleans a name
 * this way when it records it, and reads clean it again (a record an older Inbox wrote).
 */
export function inboxSentFromName(name: string): string {
  const line = name
    // Every control and format character but the zero-width joiner, which holds an emoji like 👨‍👩‍👧 together.
    .replace(/(?!\u200D)[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= NAME_MAX) return line;
  let kept = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)) {
    if (kept.length + segment.length > NAME_MAX - 1) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/** A stored value read back: null for anything not of the shape (an older or newer Inbox wrote it, or nothing did). */
export function inboxSentFromOf(value: unknown): InboxSentFrom | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { kind?: unknown; name?: unknown; via?: unknown };
  if (isInboxSentFromPlace(record.kind)) return { kind: record.kind };
  if (record.kind === "here") return { kind: "here" };
  if (record.kind !== "machine" || typeof record.name !== "string") return null;
  const name = inboxSentFromName(record.name);
  if (!name) return null;
  return { kind: "machine", name, ...(isInboxSentFromPlace(record.via) ? { via: record.via } : {}) };
}

const PLACE_WORDS: Record<InboxSentFromPlace, string> = {
  tailnet: "another device over Tailscale",
  cloudflare: "another device through Cloudflare Access",
  phone: "the Plannotator phone app",
};

/**
 * The one line an agent reads for a message the person wrote away from this computer. Context only: where they were,
 * and the one fact that follows from it. Empty when the message says nothing (this computer, `here`, or not known).
 */
export function inboxSentFromLine(message: { sent_from?: unknown }): string {
  const from = inboxSentFromOf(message.sent_from);
  // This computer's own window: nothing to say to an agent on this computer.
  if (!from || from.kind === "here") return "";
  const where =
    from.kind === "machine"
      ? from.via
        ? `${PLACE_WORDS[from.via]}, through their linked computer \`${from.name}\``
        : `their linked computer \`${from.name}\``
      : PLACE_WORDS[from.kind];
  return `(They sent this from ${where}, not from this computer: a localhost link would not open there.)`;
}
