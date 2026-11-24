import { inboxSessionlessSend, type InboxThread } from '@plannotator/core/inbox-types';
import { isInboxPermissionSession } from '@plannotator/core/inbox-permission';
import type { ReplyResult } from '../api';
import { wordsMessage } from '../sendTargets';
import { newUuid } from '../uuid';

type QuestionInput = { idempotency_key: string; words: string; questions: []; annotation_ids: [] };
export type DiagramThreadReply = (messageId: string, question: string, source: string) => Promise<boolean>;

/** Use the thread's ordinary words recipient even when the person attached the drawing or the agent handed off. */
export function diagramReplyTarget(thread: InboxThread, source: string): string | undefined {
  if (!thread.messages.some(m => m.id === source)) return undefined;
  const target = wordsMessage(thread);
  if (thread.resolved_at && (thread.archive_seq == null || (target.seq ?? 0) <= thread.archive_seq)) return undefined;
  if (target.author.kind === 'person') return target.to?.session ? target.id : undefined;
  return !inboxSessionlessSend(target) && !isInboxPermissionSession(target.author.session) ? target.id : undefined;
}

/** A separate reply to the author of this diagram. A retry after a lost response reuses its key. */
export function diagramThreadReply(post: (messageId: string, input: QuestionInput) => Promise<ReplyResult>, accepted: (held: boolean) => void): DiagramThreadReply {
  const pending = new Map<string, string>();
  return async (messageId, question, source) => {
    const words = [question.trim(), source].filter(Boolean).join('\n\n');
    const scope = JSON.stringify([messageId, words]);
    const key = pending.get(scope) ?? newUuid();
    pending.set(scope, key);
    const result = await post(messageId, { idempotency_key: key, words, questions: [], annotation_ids: [] });
    if (!result.reply && !result.held && !result.replayed) return false;
    pending.delete(scope);
    accepted(!!result.held);
    return true;
  };
}
