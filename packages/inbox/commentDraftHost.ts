import type { CommentDraftHost, HostCommentDraft } from '@plannotator/ui/components/CommentDraftHost';
import { inboxApi, InboxApiError } from './api';

export function commentDraftHost(threadId: string): CommentDraftHost {
  const bases = new Map<string, string | null>();
  const read = async (key: string): Promise<HostCommentDraft | null> => {
    const { draft } = await inboxApi.commentDraft(threadId, key);
    bases.set(key, draft?.updated_at ?? null);
    return draft ? { text: draft.text, images: draft.images } : null;
  };
  return {
    read,
    write: async (key, draft, options) => {
      if (draft === null && options?.force) {
        await inboxApi.deleteCommentDraft(threadId, key);
        bases.set(key, null);
        return 'saved';
      }
      try {
        const saved = await inboxApi.saveCommentDraft(threadId, {
          key,
          text: draft?.text ?? '',
          images: draft?.images ?? [],
          base: bases.get(key) ?? null,
          ...(options?.force ? { force: true } : {}),
        });
        bases.set(key, saved.draft?.updated_at ?? null);
        return 'saved';
      } catch (cause) {
        if (!(cause instanceof InboxApiError) || cause.code !== 'draft_conflict') throw cause;
        return { conflict: await read(key) };
      }
    },
  };
}
