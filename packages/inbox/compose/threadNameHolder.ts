import type { InboxAuthor } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { wordsMessage } from '../sendTargets';
import { pinnedState, type PinnedState } from '../pins';
import { hostLabel } from './model';

export const THREAD_NAME_TAKEN = 'Another open thread in this project has this name.';

export interface ThreadNameHolder {
  threadId: string;
  messageId: string;
  name: string;
  agent: string;
  author: InboxAuthor;
  state: PinnedState | null;
}

export async function threadNameHolder(threadId: string): Promise<ThreadNameHolder | null> {
  try {
    const { thread, row } = await inboxApi.thread(threadId, 5000);
    if (thread.resolved_at !== null || thread.thread_name === null) return null;
    const target = wordsMessage(thread);
    const author: InboxAuthor = target.author.kind === 'agent' ? target.author : { kind: 'agent', host: target.to?.host ?? null, session: target.to?.session ?? null, name: null };
    const agent = (author.kind === 'agent' ? author.name : null) ?? (author.kind === 'agent' && author.host ? hostLabel(author.host) : 'That thread’s agent');
    return { threadId, messageId: target.id, name: thread.thread_name, agent, author, state: row ? pinnedState(row) : null };
  } catch {
    return null;
  }
}
