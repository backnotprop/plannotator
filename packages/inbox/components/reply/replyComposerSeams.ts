/**
 * The reply box's controller's two wrappers around what a host hands it (useReplyComposer.tsx): its draft store, so a
 * refused save's own error (the 409 and what it carries) reaches the host, and its uploader, so a refusal the host
 * worded for the person is the line its tile shows. Each forwards to the host as it is at the call (`now()`).
 */
import type { DraftFileUploader, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { InboxApiError } from '../../apiError';
import { codeOf } from '../../replyDraftKeys';
import type { MentionRefs } from '../../threadMentions';
import type { ReplyComposerHost } from './replyComposerHost';

/** No host way to name a thread: a pasted id stays words, and nothing is read. */
export const NO_MENTION_REFS: MentionRefs = { known: () => null, resolve: async () => null };

/** A rejection with words for the person (`{ message }` or an Error): as the Inbox's own refusal, which its tile shows. */
function forPerson(cause: unknown): unknown {
  if (cause instanceof DOMException && cause.name === 'AbortError') return cause;
  const message = cause && typeof cause === 'object' ? (cause as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() !== '' ? new InboxApiError(400, codeOf(cause) ?? 'upload_refused', message) : cause;
}

export function hostSeams(now: () => ReplyComposerHost) {
  /** Per thread: the last save the store refused as `draft_conflict`, as the store threw it. */
  const refusals = new Map<string, unknown>();
  const store: ReplyDraftStore = {
    read: (threadId) => now().draftStore.read(threadId),
    save: (threadId, input, options) =>
      now()
        .draftStore.save(threadId, input, options)
        .then(
          (answer) => (refusals.delete(threadId), answer),
          (cause) => {
            if (codeOf(cause) === 'draft_conflict') refusals.set(threadId, cause);
            throw cause;
          },
        ),
    discard: (threadId, options) => now().draftStore.discard(threadId, options),
    notLanded: (threadId) => now().draftStore.notLanded?.(threadId) ?? null,
  };
  const first = now().uploader;
  const uploader: DraftFileUploader = {
    upload: (file, options) =>
      now()
        .uploader.upload(file, options)
        .catch((cause) => {
          throw forPerson(cause);
        }),
    readText: (uploadId) => now().uploader.readText(uploadId),
    ...(first.reuse
      ? {
          reuse: (id: string, version: 'current' | 'sent', options: { signal: AbortSignal; sha256?: string }) =>
            now()
              .uploader.reuse!(id, version, options)
              .catch((cause) => {
                throw forPerson(cause);
              }),
        }
      : {}),
    ...(first.previewUrl ? { previewUrl: (uploadId: string) => now().uploader.previewUrl?.(uploadId) ?? null } : {}),
  };
  return { store, uploader, refusals };
}
