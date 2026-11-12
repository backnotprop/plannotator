import { inboxSearchBodyText } from "./search";

export const INBOX_WAKE_QUOTE_WORDS = 10;

const OPENS_WITH_BLOCK = /^:{3,}/;
const OPENS_WITH_PICTURE = /^(?:\[?!\[|<img\b)/i;

function firstWords(text: string): string {
  const words = inboxSearchBodyText(text).split(/\s+/).filter((word) => word !== "");
  return words.length > INBOX_WAKE_QUOTE_WORDS ? `${words.slice(0, INBOX_WAKE_QUOTE_WORDS).join(" ")}…` : words.join(" ");
}

export function inboxWakeQuote(body: string, asked: readonly { kind: string; prompt: string; position: number }[]): { quote: string } | { questions?: number; actions?: number } {
  const opening = body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const inOrder = [...asked].sort((a, b) => a.position - b.position);
  if (OPENS_WITH_BLOCK.test(opening) || OPENS_WITH_PICTURE.test(opening)) {
    for (const question of inOrder) {
      const words = firstWords(question.prompt);
      if (words) return { quote: words };
    }
  }
  const words = OPENS_WITH_BLOCK.test(opening) ? "" : firstWords(body);
  if (words) return { quote: words };
  const actions = inOrder.filter((question) => question.kind === "action").length;
  const questions = inOrder.length - actions;
  return { ...(questions > 0 ? { questions } : {}), ...(actions > 0 ? { actions } : {}) };
}
