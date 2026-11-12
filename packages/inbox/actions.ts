import {
  readInboxQuestionKind,
  type InboxMessageWire,
  type InboxQuestion,
  type InboxThread,
} from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

export function isAnswerableQuestion(question: Pick<InboxQuestion, 'kind'>): boolean {
  const kind = readInboxQuestionKind(question.kind);
  return kind !== 'action' && kind !== 'unknown';
}

export function isActionRecord(question: Pick<InboxQuestion, 'kind'>): boolean {
  return readInboxQuestionKind(question.kind) === 'action';
}

export function questionsOnly(questions: readonly InboxQuestion[] | undefined): InboxQuestion[] {
  return (questions ?? []).filter(isAnswerableQuestion);
}

export function splitMessageActions(message: InboxMessageWire): InboxMessageWire {
  const all = message.questions;
  if (!all || !all.some((q) => !isAnswerableQuestion(q))) return message;
  const { questions: _all, actions: _old, ...rest } = message;
  const questions = questionsOnly(all);
  const actions = all.filter(isActionRecord);
  return {
    ...rest,
    ...(questions.length > 0 ? { questions } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

export function splitThreadActions(thread: InboxThread): InboxThread {
  return { ...thread, messages: thread.messages.map(splitMessageActions) };
}

export function actionForBlock(
  body: string,
  actions: readonly InboxQuestion[] | undefined,
  block: { startLine: number; content: string },
): InboxQuestion | null {
  if (!actions || actions.length === 0) return null;
  const parsed = parseInboxActionBlocks(body);
  const hit = parsed.find((a) => a.startLine === block.startLine) ?? null;
  if (!hit) return null;
  return actions.find((a) => a.key === hit.key) ?? actions.find((a) => a.position === hit.position) ?? null;
}

export type ActionCardState = 'open' | 'pending' | 'done' | 'cant' | 'seen' | 'set-aside' | 'archived' | 'replaced';

export function actionCardState(action: InboxQuestion): ActionCardState {
  const result = action.action_result ?? null;
  if (action.state === 'superseded') return 'replaced';
  if (result?.by === 'agent') return 'seen';
  if (action.state === 'closed') return action.set_aside_at ? 'set-aside' : 'archived';
  if (!result) return 'open';
  if (action.state === 'picked') return 'pending';
  return result.outcome === 'cant' ? 'cant' : 'done';
}
