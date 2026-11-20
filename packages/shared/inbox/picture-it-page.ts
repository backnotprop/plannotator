import { readFile } from "node:fs/promises";
import { INBOX_VIEW_MAX_BYTES, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import { isPictureItPage, pictureItPageTitle, type InboxPictureItPage } from "@plannotator/core/picture-it-page";
import { inboxBlobPath } from "./attachments";

export async function readInboxPictureItPage(inboxDirPath: string, attachments: readonly InboxAttachment[]): Promise<InboxPictureItPage | null> {
  for (const attachment of attachments) {
    if (readInboxAttachmentKind(attachment.kind) !== "html" || attachment.size > INBOX_VIEW_MAX_BYTES) continue;
    let html: string;
    try {
      html = await readFile(inboxBlobPath(inboxDirPath, attachment.sent_sha256), "utf8");
    } catch {
      continue;
    }
    if (isPictureItPage(html)) return { attachment_id: attachment.id, title: pictureItPageTitle(html) || attachment.name };
  }
  return null;
}
