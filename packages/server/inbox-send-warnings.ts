/**
 * Two of send_message's warnings (the message is sent either way; the result says what the person will not see):
 *
 * - `question_media_not_shown`: a sound or video written inside a question (a picture choice, `Shows:`, `Before:` /
 *   `After:`). The question card draws pictures only, so it shows as text there; the body plays it.
 * - `pages_not_shown`: an attached HTML page whose own bytes are already past what the page route keeps
 *   (`INBOX_PAGE_MAX_BYTES`): the person gets the file's "too large" card instead of the page. The route measures the
 *   document the window frames, which the window builds from the page (its asset links rewritten, its bridge and
 *   theme added): never smaller than the page, and not known here. So this names only a page that can never show,
 *   and says nothing of one just under the limit whose framed document still goes over: a lower bound, never a
 *   false warning.
 */
import { formatBytes } from "@plannotator/core/inbox-format";
import { inboxQuestionMedia } from "@plannotator/core/inbox-questions";
import { INBOX_PAGE_MAX_BYTES } from "./inbox-pages";

/** The most of each the warning names (the structured list and the text alike); the rest are counted. */
export const SEND_WARNINGS_MAX = 10;

export interface QuestionMediaNotShown {
  ref: string;
  /** The question's key. */
  question: string;
}

export interface PageNotShown {
  name: string;
  size: number;
  limit: number;
}

export function questionMediaNotShown(body: string): QuestionMediaNotShown[] {
  try {
    return inboxQuestionMedia(body).map(({ src, key }) => ({ ref: src, question: key }));
  } catch {
    return [];
  }
}

export function pagesNotShown(attachments: readonly { name: string; kind: string; size: number }[] | null | undefined): PageNotShown[] {
  return (attachments ?? []).filter((file) => file.kind === "html" && file.size > INBOX_PAGE_MAX_BYTES).map(({ name, size }) => ({ name, size, limit: INBOX_PAGE_MAX_BYTES }));
}

function listed<T>(list: readonly T[], say: (item: T) => string): string {
  const named = list.slice(0, SEND_WARNINGS_MAX).map(say).join("; ");
  return list.length > SEND_WARNINGS_MAX ? `${named}; …and ${list.length - SEND_WARNINGS_MAX} more` : named;
}

export function questionMediaNotShownText(list: readonly QuestionMediaNotShown[]): string {
  if (list.length === 0) return "";
  const what = list.length === 1 ? "A video or sound inside a question does not play; it shows as text" : `${list.length} videos or sounds inside questions do not play; they show as text`;
  return ` ${what}: ${listed(list, ({ ref, question }) => `${ref} (question ${question})`)}. Put ${list.length === 1 ? "it" : "each"} in the body outside the question, where it plays.`;
}

export function pagesNotShownText(list: readonly PageNotShown[]): string {
  if (list.length === 0) return "";
  const what = list.length === 1 ? "This page is too large to show in the Inbox" : `${list.length} pages are too large to show in the Inbox`;
  return ` ${what}: ${listed(list, ({ name, size }) => `${name} (${formatBytes(size)})`)}; a page shows up to ${formatBytes(INBOX_PAGE_MAX_BYTES)}, and the person gets a download card instead. Make it smaller, for example by keeping large pictures and videos as files beside it.`;
}
