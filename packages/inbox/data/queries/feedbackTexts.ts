import { isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { inboxApi } from '../../api';

export async function readFeedbackTexts(pending: readonly InboxAnnotationRecord[], files: readonly InboxAttachmentState[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const record of pending) {
    if (record.guide || record.message || record.live) continue;
    const attachment = files.find((a) => a.id === record.attachment_id) ?? files.find((a) => a.path === record.path);
    if (!attachment) continue;
    const key = `${attachment.id}\0${record.version}`;
    if (texts.has(key)) continue;
    const kind = readInboxAttachmentKind(attachment.kind);
    if (!isInboxTextKind(kind) || kind === 'code') continue;
    try {
      texts.set(key, (await inboxApi.view(attachment.id, record.version === 'current' ? 'current' : 'sent')).text);
    } catch {
      texts.set(key, '');
    }
  }
  return texts;
}
