/**
 * The Drafts the window lists (`GET /api/inbox/drafts`): New message drafts, and the threads holding unsent work
 * (reply words, picks, comments: approval "inbox-reply-drafts"), in the cache. Read when a record or a `drafts` signal
 * can change them (draftsReads.ts says when); New message's own saves change them in place (`changeDrafts`).
 * A read that brought nothing new keeps every row the same object (structural sharing), so nothing is drawn again.
 *
 * A thread's own reply draft (its words and files as the box saves them) is not here: replyDraft.ts keeps its saves
 * in order, with the conflict and Send-claim rules, and reads it per thread.
 */
import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';
import type { InboxReplyDraftRow } from '@plannotator/core/inbox-types';
import { inboxApi, type DraftView } from '../../api';
import { inboxKeys } from '../keys';

export type DraftsModel = Awaited<ReturnType<typeof inboxApi.drafts>>;

const NO_REPLIES: InboxReplyDraftRow[] = [];

/** Read the drafts and hold them; throws when the read fails (what was held stays). */
export async function readDrafts(client: QueryClient): Promise<void> {
  const next = await inboxApi.drafts();
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), next);
}

/** New message's drafts changed here (sent, discarded, saved): drawn at once, the next read confirms. */
export function changeDrafts(client: QueryClient, change: (drafts: DraftView[]) => DraftView[]): void {
  client.setQueryData<DraftsModel>(inboxKeys.drafts(), (held) => (held ? { ...held, drafts: change(held.drafts) } : { serverSession: '', drafts: change([]), replies: NO_REPLIES }));
}

/** The reply drafts held now, for what reads them outside a render. */
export function heldReplyDrafts(client: QueryClient): InboxReplyDraftRow[] {
  return client.getQueryData<DraftsModel>(inboxKeys.drafts())?.replies ?? NO_REPLIES;
}

/** The drafts held (null: not read yet), redrawn when they change. Never reads: the window does. */
export function useDrafts(): { drafts: DraftView[] | null; replies: InboxReplyDraftRow[] } {
  const { data } = useQuery<DraftsModel>({ queryKey: inboxKeys.drafts(), queryFn: skipToken, gcTime: Infinity, notifyOnChangeProps: ['data'] });
  return { drafts: data?.drafts ?? null, replies: data?.replies ?? NO_REPLIES };
}
