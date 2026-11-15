import { useEffect } from 'react';
import type { InboxDraft, InboxDraftFile, InboxMessageWire, InboxReplyDraft } from '@plannotator/core/inbox-types';
import { takeBackOffered, useTakeBack } from '../takeBack';

export interface ThreadTakeBackHost {
  threadId: string;
  only: boolean;
  allowed: boolean;
  lastBlocked: (message: InboxMessageWire) => boolean;
  nameOf: (message: InboxMessageWire) => string;
  settle: () => Promise<boolean>;
  reload: () => Promise<InboxReplyDraft | null | undefined>;
  fill: (body: string, files: readonly InboxDraftFile[]) => void;
  compose: (draft: InboxDraft) => void;
  changed: () => Promise<void>;
}

export function useThreadTakeBack(host: ThreadTakeBackHost) {
  const takeBack = useTakeBack({ settle: host.settle, reload: host.reload, fill: (draft) => host.fill(draft.body, draft.files ?? []), compose: host.compose, changed: host.changed });
  useEffect(() => takeBack.clear(), [host.threadId]);
  const takeBackOf = (message: InboxMessageWire) =>
    host.allowed && message.author.kind === 'person' && takeBackOffered(message, host.only) && !host.lastBlocked(message) ? () => void takeBack.take(message.id, host.nameOf(message)) : null;
  return { takeBack, takeBackOf };
}
