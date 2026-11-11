import type { DraftFileUploader, ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { inboxApi, pageServerSession, replyDraftSaveBody, reuseAttachment, uploadFile } from './api';
import { inboxUrl } from './inboxUrl';

/**
 * A browser takes at most 64 KiB of keepalive bodies in flight (more is refused at once), so the save sent as the
 * page goes stays under it, with room for another small keepalive.
 */
export const KEEPALIVE_BODY_MAX = 60 * 1024;

export function keepaliveBody(full: Record<string, unknown>): { body: string; keepalive: boolean } {
  const fits = (text: string) => new TextEncoder().encode(text).length <= KEEPALIVE_BODY_MAX;
  const whole = JSON.stringify(full);
  if (fits(whole)) return { body: whole, keepalive: true };
  const { base_body: _baseBody, ...words } = full;
  const lean = JSON.stringify(words);
  return { body: lean, keepalive: fits(lean) };
}

const saveBody = (input: ReplyDraftSaveInput) => replyDraftSaveBody(input.body, input.base, input.baseBody, input.files, input.recipients);

export const httpReplyDraftStore: ReplyDraftStore = {
  read: async (threadId) => (await inboxApi.replyDraft(threadId)).draft ?? null,
  save: async (threadId, input, options) => {
    if (!options.keepalive) return inboxApi.saveReplyDraft(threadId, input.body, input.base, input.baseBody, input.files, input.recipients);
    // As the page goes: its answer is never read (the window reads the draft back when it comes back).
    const session = pageServerSession();
    void fetch(inboxUrl(`/threads/${encodeURIComponent(threadId)}/draft`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...keepaliveBody({ ...saveBody(input), ...(session ? { serverSession: session } : {}) }),
    }).catch(() => {});
    return { draft: null };
  },
  discard: async (threadId) => {
    await inboxApi.discardReplyDraft(threadId);
  },
};

export function httpDraftFileUploader(machine: () => string | null): DraftFileUploader {
  return {
    upload: (file, options) => uploadFile(file, { machine: machine(), signal: options.signal, onProgress: options.onProgress }),
    readText: async (uploadId) => (await inboxApi.uploadText(uploadId, machine())).text,
    reuse: (attachmentId, version, options) => reuseAttachment(attachmentId, version, options),
  };
}
