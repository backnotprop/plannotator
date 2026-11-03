/**
 * The Plannotator Inbox's own storage behind the reply draft's seam
 * (@plannotator/core/inbox-reply-draft): drafts through
 * `/api/inbox/threads/:id/draft`, a file's bytes as a pending upload
 * (`/api/inbox/uploads`). The reply box's hooks (replyDraft.ts,
 * compose/ComposeFiles.tsx) use these unless their host passes its own: a host
 * with other storage (Workspaces, bytes private to the person until Send) swaps
 * them, and the box's behavior stays the same.
 */
import type { DraftFileUploader, ReplyDraftSaveInput, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { inboxApi, pageServerSession, replyDraftSaveBody, uploadFile } from './api';
import { inboxUrl } from './inboxUrl';

/**
 * A browser takes at most 64 KiB of keepalive bodies in flight (more is refused at once), so the save sent as the
 * page goes stays under it, with room for another small keepalive.
 */
export const KEEPALIVE_BODY_MAX = 60 * 1024;

/**
 * The page's last save as a fetch's `body` and `keepalive`. Whole when it fits a keepalive. Larger (a long draft
 * whose last save's words, `base_body`, double it), it goes without `base_body`: the words alone, compared on
 * `base` only. Still larger (the words themselves over the limit), it goes as an ordinary fetch: sent as the page
 * goes, it lands only if the page lives long enough to send it.
 */
export function keepaliveBody(full: Record<string, unknown>): { body: string; keepalive: boolean } {
  const fits = (text: string) => new TextEncoder().encode(text).length <= KEEPALIVE_BODY_MAX;
  const whole = JSON.stringify(full);
  if (fits(whole)) return { body: whole, keepalive: true };
  const { base_body: _baseBody, ...words } = full;
  const lean = JSON.stringify(words);
  return { body: lean, keepalive: fits(lean) };
}

const saveBody = (input: ReplyDraftSaveInput) => replyDraftSaveBody(input.body, input.base, input.baseBody, input.files, input.recipients);

/** Reply drafts on this computer's Inbox. */
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

/** A file's bytes as a pending upload on this Inbox, or (`machine`) on the linked machine whose thread it is. */
export function httpDraftFileUploader(machine: () => string | null): DraftFileUploader {
  return {
    upload: (file, options) => uploadFile(file, { machine: machine(), signal: options.signal, onProgress: options.onProgress }),
    readText: async (uploadId) => (await inboxApi.uploadText(uploadId, machine())).text,
  };
}
