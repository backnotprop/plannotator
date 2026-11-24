import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { isContested, machineOf } from '../inboxUrl';
import { PaneScopeContext, type PaneScopeValue } from '../panes/scope';
import type { InboxToastModel } from '../components/Toast';
import { diagramReplyTarget, diagramThreadReply, type DiagramThreadReply } from './diagramThreadReply';

interface QuestionRoutes {
  threadId?: string;
  side?: (selected: string, source?: string) => void;
  replyFor?: (source: string) => DiagramThreadReply | undefined;
}
const DiagramQuestions = createContext<QuestionRoutes>({});
export function useDiagramQuestionRoutes(source: string) {
  const { replyFor, side, threadId } = useContext(DiagramQuestions);
  return { side, threadId, reply: replyFor?.(source) };
}

/** The owning pane supplies the thread author and transport, including its linked-machine outbox. */
export function DiagramThreadScope({ scope, thread, showToast, afterWrite, side, children }: {
  scope: PaneScopeValue;
  thread: InboxThread | null;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  afterWrite: () => Promise<void>;
  side?: QuestionRoutes['side'];
  children: ReactNode;
}) {
  const latest = useRef({ thread, showToast, afterWrite });
  latest.current = { thread, showToast, afterWrite };
  const threadId = thread?.thread_id;
  const send = useMemo(() => diagramThreadReply(inboxApi.reply, held => {
    latest.current.showToast({ icon: held ? 'clock' : 'check', lead: held ? 'Question waiting in the outbox' : 'Question sent to thread' });
    void latest.current.afterWrite().catch(() => {});
  }), [threadId]);
  const routes = useMemo<QuestionRoutes>(() => ({ side, threadId, replyFor: (source) => {
    if (!thread || !threadId || isContested(source) || isContested(threadId)) return undefined;
    const target = diagramReplyTarget(thread, source);
    if (!target || isContested(target) || machineOf(target) !== machineOf(threadId) || machineOf(source) !== machineOf(threadId)) return undefined;
    return (id, question, detail, revision) => {
      const current = latest.current.thread;
      if (id !== source || current?.thread_id !== threadId || diagramReplyTarget(current, source) !== target) return Promise.resolve(false);
      return send(target, question, detail, revision);
    };
  } }), [thread, threadId, side, send]);
  return <PaneScopeContext.Provider value={scope}>
    <DiagramQuestions.Provider value={routes}>{children}</DiagramQuestions.Provider>
  </PaneScopeContext.Provider>;
}
