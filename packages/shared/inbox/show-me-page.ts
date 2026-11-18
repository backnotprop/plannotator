import { readFile } from "node:fs/promises";
import { INBOX_VIEW_MAX_BYTES, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import { isShowMePage, showMePageTitle, type InboxShowMePage } from "@plannotator/core/show-me-page";
import { inboxBlobPath } from "./attachments";

export async function readInboxShowMePage(inboxDirPath: string, attachments: readonly InboxAttachment[]): Promise<InboxShowMePage | null> {
  for (const attachment of attachments) {
    if (readInboxAttachmentKind(attachment.kind) !== "html" || attachment.size > INBOX_VIEW_MAX_BYTES) continue;
    let html: string;
    try {
      html = await readFile(inboxBlobPath(inboxDirPath, attachment.sent_sha256), "utf8");
    } catch {
      continue;
    }
    if (isShowMePage(html)) return { attachment_id: attachment.id, title: showMePageTitle(html) || attachment.name };
  }
  return null;
}
