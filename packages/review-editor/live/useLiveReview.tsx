import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { HostLineNote } from '../components/hostLineNotes';
import type { ReviewSidebarExtraTab } from '../components/ReviewSidebar';
import { liveApi, liveKey, LiveError, watchLive, type LiveSendTag } from './api';
import { anchorOfComment, openThreadIds, placeThreads, stepThread, unsentComments, type LiveAgent, type LiveState, type PlacedThread } from './model';
import { LiveThreadCard } from './LiveThreadCard';
import { LiveThreadsTab } from './LiveThreadsTab';

export const LIVE_TAB_ID = 'threads';

export interface LiveReviewActions {
  agents: readonly LiveAgent[];
  defaultTo: LiveAgent | null;
  loadAgents: () => void;
  reply: (messageId: string, words: string, tags: LiveSendTag[]) => Promise<void>;
  resolve: (conversationId: string, resolved: boolean) => Promise<void>;
  sendComments: (comments: readonly CodeAnnotation[], words: string, tags: LiveSendTag[]) => Promise<void>;
  reveal: (thread: PlacedThread) => void;
  error: string | null;
}

export function useLiveReview(input: {
  files: readonly { path: string; patch: string }[];
  annotations: readonly CodeAnnotation[];
  dropAnnotations: ((ids: readonly string[]) => void) | null;
  revealLines: (filePath: string, start: number, end: number, side: 'old' | 'new') => void;
  openTab: (id: string) => void;
}): { notes: readonly HostLineNote[]; tab: ReviewSidebarExtraTab | null } {
  const [state, setState] = useState<LiveState | null>(null);
  const [agents, setAgents] = useState<readonly LiveAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const threadRef = useRef<string | null>(null);
  threadRef.current = state?.thread?.id ?? null;

  const refresh = useCallback(() => {
    liveApi.state().then(setState, () => {});
  }, []);
  const loadAgents = useCallback(() => {
    liveApi.agents().then((answer) => setAgents(answer.agents), () => {});
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (state?.inbox) loadAgents();
  }, [state?.inbox, loadAgents]);
  const watching = !!state?.inbox && !!state.thread;
  useEffect(() => (watching ? watchLive(() => threadRef.current, refresh) : undefined), [watching, refresh]);

  const placed = useMemo(() => placeThreads(state?.messages ?? [], input.files), [state?.messages, input.files]);
  const order = useMemo(() => openThreadIds(placed, input.files.map((f) => f.path)), [placed, input.files]);
  const unsent = useMemo(() => unsentComments(input.annotations, placed), [input.annotations, placed]);

  const defaultTo = useMemo(() => {
    const to = state?.thread?.to ?? state?.launched_by ?? null;
    return (to && agents.find((a) => a.session === to.session)) ?? null;
  }, [state?.thread?.to, state?.launched_by, agents]);

  const failed = useCallback((e: unknown) => {
    setError(e instanceof LiveError ? e.message : 'The Inbox did not answer. Try again in a moment.');
    throw e;
  }, []);

  const sendComments = useCallback(
    async (comments: readonly CodeAnnotation[], words: string, tags: LiveSendTag[]) => {
      setError(null);
      const to = defaultTo ? { host: defaultTo.host, session: defaultTo.session } : tags[0];
      await liveApi
        .send({
          comments: comments.map((c) => ({ anchor: anchorOfComment({ filePath: c.filePath, lineStart: c.lineStart, lineEnd: c.lineEnd, side: c.side, scope: c.scope }, input.files), words: c.text })),
          ...(words.trim() ? { words: words.trim() } : {}),
          ...(to && !state?.thread ? { to } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          idempotency_key: liveKey(),
        })
        .catch(failed);
      input.dropAnnotations?.(comments.map((c) => c.id));
      refresh();
    },
    [defaultTo, state?.thread, input.files, input.dropAnnotations, failed, refresh],
  );

  const reply = useCallback(
    async (messageId: string, words: string, tags: LiveSendTag[]) => {
      setError(null);
      await liveApi.reply(messageId, { words, ...(tags.length > 0 ? { tags } : {}), idempotency_key: liveKey() }).catch(failed);
      refresh();
    },
    [failed, refresh],
  );

  const resolve = useCallback(
    async (conversationId: string, resolved: boolean) => {
      setError(null);
      await liveApi.resolve(conversationId, resolved).catch(failed);
      refresh();
    },
    [failed, refresh],
  );

  const reveal = useCallback(
    (thread: PlacedThread) => {
      setFocused(thread.conversation.id);
      const anchor = thread.conversation.anchor;
      input.revealLines(anchor.file, Math.max(1, thread.now.line_start), Math.max(1, thread.now.line_end), anchor.side);
    },
    [input.revealLines],
  );

  const actions: LiveReviewActions = { agents, defaultTo, loadAgents, reply, resolve, sendComments, reveal, error };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const notes = useMemo<HostLineNote[]>(() => {
    if (!state?.inbox) return [];
    return placed
      .filter((p) => p.inDiff)
      .map((thread) => ({
        id: `live:${thread.conversation.id}`,
        filePath: thread.conversation.anchor.file,
        line: thread.now.line_end,
        side: thread.conversation.anchor.side,
        key: JSON.stringify([agents.length, thread.now, thread.conversation.resolved, thread.conversation.messages.map((m) => [m.id, m.delivery?.at ?? null, (m.tags ?? []).map((t) => t.delivery?.at ?? null)])]),
        render: () => <LiveThreadCard thread={thread} messages={state.messages} actions={actionsRef} />,
      }));
  }, [state, placed, agents.length]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const next = stepThread(order, focused, direction);
      const thread = placed.find((p) => p.conversation.id === next);
      if (thread) actionsRef.current.reveal(thread);
    },
    [order, focused, placed],
  );

  const visible = !!state?.inbox && (placed.length > 0 || agents.length > 0);
  const tab = useMemo<ReviewSidebarExtraTab | null>(
    () =>
      visible
        ? {
            id: LIVE_TAB_ID,
            label: 'Threads',
            ...(order.length > 0 ? { count: order.length } : {}),
            render: () => <LiveThreadsTab placed={placed} unsent={unsent} order={order} focused={focused} onStep={step} threadUrl={state?.thread_url ?? null} actions={actionsRef} />,
          }
        : null,
    [visible, order, placed, unsent, focused, step, agents, error, defaultTo, state?.thread_url],
  );
  useEffect(() => {
    if (error) input.openTab(LIVE_TAB_ID);
  }, [error, input.openTab]);

  return { notes, tab };
}
