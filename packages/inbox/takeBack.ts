import { useState } from 'react';
import type { InboxDraft, InboxMessageWire, InboxReplyDraft } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from './api';

export const TAKE_BACK_LABEL = 'Take back';

export interface TakeBackState {
  id: string;
  busy: boolean;
  line: string | null;
  note: string | null;
}

export function takeBackRefusal(error: unknown, name: string): string {
  if (error instanceof InboxApiError && error.code === 'agent_has_it') {
    return error.by === 'handing'
      ? `${name} is picking up its messages right now, so this can't be taken back. Try again in a few seconds.`
      : `${name} already has this message, so it can't be taken back. Reply below to change it.`;
  }
  if (error instanceof InboxApiError && (error.code === 'cannot_take_back' || error.code === 'taken_back')) return error.message;
  return 'It was not taken back. Try again.';
}

export function takeBackOffered(message: InboxMessageWire, only: boolean): boolean {
  if (message.author.kind !== 'person' || message.delivery || message.taken_back_at || message.read_by_agent || message.launch || message.handoff || message.review_verdict) return false;
  if (message.ack_of || message.tidy || (message.set_aside?.length ?? 0) > 0 || (message.reopened?.length ?? 0) > 0 || (message.reask?.length ?? 0) > 0) return false;
  if (message.tags?.some((tag) => tag.delivery || tag.read_at)) return false;
  if ((message.sent_annotations ?? 0) > 0) return false;
  return message.id !== message.thread_id || only;
}

export function useTakeBack(host: {
  settle: () => Promise<boolean>;
  reload: () => Promise<InboxReplyDraft | null | undefined>;
  fill: (draft: InboxReplyDraft) => void;
  compose: (draft: InboxDraft) => void;
  changed: () => Promise<void>;
}) {
  const [state, setState] = useState<TakeBackState | null>(null);
  const take = async (id: string, name: string) => {
    setState({ id, busy: true, line: null, note: null });
    if (!(await host.settle())) {
      setState({ id, busy: false, line: 'Your reply is still saving. Try again in a moment.', note: null });
      return;
    }
    try {
      const answer = await inboxApi.takeBack(id);
      if (answer.compose) {
        setState(null);
        host.compose(answer.compose);
        return;
      }
      const draft = (await host.reload()) ?? answer.draft;
      if (draft) host.fill(draft);
      setState({ id, busy: false, line: null, note: `Taken back. ${name} never got it. Send it again when it's ready.` });
      await host.changed();
    } catch (error) {
      setState({ id, busy: false, line: takeBackRefusal(error, name), note: null });
    }
  };
  return { state, take, clear: () => setState(null) };
}
