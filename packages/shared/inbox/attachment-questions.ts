import { readFile } from "node:fs/promises";
import { shouldStripFrontmatter } from "@plannotator/core/annotatable";
import { INBOX_VIEW_MAX_BYTES, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import { parseInboxQuestionBlocks, type ParsedInboxQuestion } from "@plannotator/core/inbox-questions";
import { inboxBlobPath } from "./attachments";

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
