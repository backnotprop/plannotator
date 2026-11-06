/**
 * The words a wake's "Replying to your message…" line quotes (approval
 * "inbox-wake-context"): about the first ten words of the message, plain text.
 * The wake cleans them once more where it prints them (`inboxWakeReplyingLine`).
 */

import { inboxSearchBodyText } from "./search";

/** How many words a quote carries. */
export const INBOX_WAKE_QUOTE_WORDS = 10;

const OPENS_WITH_BLOCK = /^:{3,}/;
const OPENS_WITH_PICTURE = /^(?:\[?!\[|<img\b)/i;

/** About the first ten words of `text` as plain text, with an ellipsis when there are more. '' when it has no words. */
function firstWords(text: string): string {
  const words = inboxSearchBodyText(text).split(/\s+/).filter((word) => word !== "");
  return words.length > INBOX_WAKE_QUOTE_WORDS ? `${words.slice(0, INBOX_WAKE_QUOTE_WORDS).join(" ")}…` : words.join(" ");
}

/**
 * What the line says about a message of the agent's: its first words; for a
 * message opening with a question or a picture, its first question's own
 * words; and with no words at all, how many questions and action items it
 * asked (`{ questions: 3 }`).
 */
export function inboxWakeQuote(body: string, asked: readonly { kind: string; prompt: string; position: number }[]): { quote: string } | { questions?: number; actions?: number } {
  const opening = body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const inOrder = [...asked].sort((a, b) => a.position - b.position);
  if (OPENS_WITH_BLOCK.test(opening) || OPENS_WITH_PICTURE.test(opening)) {
    for (const question of inOrder) {
      const words = firstWords(question.prompt);
      if (words) return { quote: words };
    }
  }
  // A block's own lines are its question's, not the message's opening words.
  const words = OPENS_WITH_BLOCK.test(opening) ? "" : firstWords(body);
  if (words) return { quote: words };
  const actions = inOrder.filter((question) => question.kind === "action").length;
  const questions = inOrder.length - actions;
  return { ...(questions > 0 ? { questions } : {}), ...(actions > 0 ? { actions } : {}) };
}
