/**
 * Emoji reactions on the person's replies (approval "inbox-emoji-reactions"):
 * what the window needs to draw one. The pick itself is the Inbox server's
 * (packages/shared/inbox/reactions/).
 *
 * The fallback for old systems: the pool's modern emoji (Emoji 13 and later)
 * that a mood can reach, each with the older emoji of the same family and
 * tone a device shows when it cannot draw the modern one. The stored reaction
 * never changes; only that device draws the stand-in.
 */
export const INBOX_REACTION_FALLBACK: Readonly<Record<string, string>> = {
  "🫶": "❤️",
  "🩷": "💖",
  "🩵": "💙",
  "🫡": "👍",
  "🙂‍↕️": "👌",
};
