/**
 * Action items in the Inbox window (approval "inbox-next-actions", direction "In the
 * thread"): an agent's `:::action` block is a card in its message, and
 * nothing else. The server keeps each action item as a question record of kind
 * "action" and lists it in the message's `questions`; the window moves them
 * to `actions` as it reads a thread, so the picks, the Send, Re-ask and the
 * reply box never meet one.
 */

import {
  readInboxQuestionKind,
  type InboxMessageWire,
  type InboxQuestion,
  type InboxThread,
} from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

/** A question the window may answer: a kind it knows that is not an action item (fail-closed: an unknown kind is neither). */
export function isAnswerableQuestion(question: Pick<InboxQuestion, 'kind'>): boolean {
  const kind = readInboxQuestionKind(question.kind);
  return kind !== 'action' && kind !== 'unknown';
}

export function isActionRecord(question: Pick<InboxQuestion, 'kind'>): boolean {
  return readInboxQuestionKind(question.kind) === 'action';
}

/** A message's questions without its action items (and without kinds this window does not know). */
export function questionsOnly(questions: readonly InboxQuestion[] | undefined): InboxQuestion[] {
  return (questions ?? []).filter(isAnswerableQuestion);
}

/** One message with its action items moved out of `questions` into `actions`. */
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

/** A thread as the window reads it: every message split (`splitMessageActions`). */
export function splitThreadActions(thread: InboxThread): InboxThread {
  return { ...thread, messages: thread.messages.map(splitMessageActions) };
}

/**
 * Which record a `:::action` block of the body draws: the block's opening
 * line (the Viewer's block and the core reader split the body the same way,
 * frontmatter off) names the parsed action item, and its key names the record.
 * Null when no parsed action item opens on that line or no record has its key.
 */
export function actionForBlock(
  body: string,
  actions: readonly InboxQuestion[] | undefined,
  block: { startLine: number; content: string },
): InboxQuestion | null {
  if (!actions || actions.length === 0) return null;
  const parsed = parseInboxActionBlocks(body);
  const hit = parsed.find((a) => a.startLine === block.startLine) ?? null;
  if (!hit) return null;
  // By its place when the key moved: a message stored before the reader dropped a task box (`- [ ] …`) from the first line.
  return actions.find((a) => a.key === hit.key) ?? actions.find((a) => a.position === hit.position) ?? null;
}

/** What an action item's card says it is, for its badge. */
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
