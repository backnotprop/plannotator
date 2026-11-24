/**
 * New thread from this message (the Inbox window's item on an agent's message's ⋯ menu): what that message's own
 * agent reads, as the person's reply to that message (approved by the owner, 2026-11-23, word for word). A message
 * with no words to quote (pictures only) drops the quoted part and keeps the id. Here, in core, so the store can tell
 * these words from the person's own: the quoted first words are the agent's, and no `#tag` is read from them.
 */
export const NEW_THREAD_FROM_MESSAGE_WORDS = (excerpt: string, messageId: string): string =>
  `Move this message of yours to a new thread${excerpt ? `: "${excerpt}"` : ''} (${messageId}). Start a new thread, named as you see fit, that carries everything in it: its text, its files and its questions. Then, in this thread, withdraw only that message's open questions (they will read "No longer applies") and say where it went. Leave everything else here as it is.`;

const ID = '\u0000';
const [HEAD, TAIL] = NEW_THREAD_FROM_MESSAGE_WORDS('', ID).split(` (${ID})`) as [string, string];

/** Whether these words are that ask (any first words, any message id), not words the person wrote. */
export function isNewThreadFromMessageAsk(words: string): boolean {
  const text = words.trim();
  return text.startsWith(HEAD) && text.endsWith(TAIL) && /\(msg_[0-9A-Za-z]+\)\. /.test(text);
}
