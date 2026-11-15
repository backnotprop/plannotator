/**
 * Questions inside attached Markdown files (issue #2828): an agent's message
 * may attach a plan or proposal that keeps each `:::question` block beside
 * the section that explains it. The window answers them where they are, like
 * the body's (the same cards, counts and Send). Here the server reads each
 * attached Markdown file's SENT version (its blob, written by
 * `recordInboxAttachments`) and parses its blocks as the file's viewer reads
 * them (`attachmentBlocks` in packages/inbox/attachments.ts: frontmatter
 * stripped for a `.md` file), so the record's key per file is the key its
 * card computes. The store records them (`InboxSendInput.attachment_questions`).
 *
 * Asynchronous: nothing blocks the event loop on a large file. A file over
 * `INBOX_VIEW_MAX_BYTES` (which the window will not show) or whose blob
 * cannot be read asks nothing. Never throws.
 */

import { readFile } from "node:fs/promises";
import { shouldStripFrontmatter } from "@plannotator/core/annotatable";
import { INBOX_VIEW_MAX_BYTES, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import { parseInboxQuestionBlocks, type ParsedInboxQuestion } from "@plannotator/core/inbox-questions";
import { inboxBlobPath } from "./attachments";

/** Each attached Markdown file's question blocks, by attachment id, in attachment order (files with none are left out). */
export async function readInboxAttachmentQuestions(
  inboxDirPath: string,
  attachments: readonly InboxAttachment[],
): Promise<{ attachment_id: string; questions: ParsedInboxQuestion[] }[]> {
  const out: { attachment_id: string; questions: ParsedInboxQuestion[] }[] = [];
  for (const attachment of attachments) {
    if (readInboxAttachmentKind(attachment.kind) !== "markdown" || attachment.size > INBOX_VIEW_MAX_BYTES) continue;
    let text: string;
    try {
      text = await readFile(inboxBlobPath(inboxDirPath, attachment.sent_sha256), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(":::question")) continue;
    let questions: ParsedInboxQuestion[];
    try {
      questions = parseInboxQuestionBlocks(text, { frontmatter: shouldStripFrontmatter(attachment.name) });
    } catch {
      continue;
    }
    if (questions.length > 0) out.push({ attachment_id: attachment.id, questions });
  }
  return out;
}
