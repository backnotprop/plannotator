import { useCallback, useRef } from 'react';
import {
  useAIChat as useSharedAIChat,
  type AIChatEntry,
  type AIRetryOptions,
  type AskAIParams,
  type PendingPermission,
} from '@plannotator/ui/hooks/useAIChat';
import { buildReviewContextPreamble, buildSessionReviewIdentity } from '@plannotator/ui/utils/aiPrompt';
export type { AIChatEntry, PendingPermission };

interface Viewing {
  scope: 'all' | 'file';
  filePath?: string;
}

interface UseAIChatOptions {
  patch: string;
  /** VCS diff type so the agent can inspect changes with git instead of a paste. */
  diffType?: string;
  /** Base branch/ref the diff is computed against. */
  base?: string | null;
  /** Server-built "changes under review" description for the current view (the
   *  shared agent-review machine's output). Latched onto each question. */
  reviewContext?: string;
  /** What the user is currently viewing (read fresh on each question). */
  viewing?: Viewing;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** The selected provider is "Ask this session": send the diff's identity,
   *  never the on-screen patch, into the agent's own session. */
  sessionBridge?: boolean;
}

export function useAIChat({
  patch,
  diffType,
  base,
  reviewContext,
  viewing,
  providerId,
  model,
  reasoningEffort,
  sessionBridge = false,
}: UseAIChatOptions) {
  const chat = useSharedAIChat({
    context: {
      mode: 'code-review',
      review: { patch, diffType, base: base ?? undefined },
    },
    providerId,
    model,
    reasoningEffort,
  });

  // View state changes mid-session; the session context is baked once. Read the
  // latest view via a ref and attach it to every question.
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  // The "changes under review" context also changes mid-session (diff-type/base/
  // whitespace/PR/scope switches). Send the full block when it first appears or
  // changes; a short reminder otherwise (see buildReviewContextPreamble).
  const reviewContextRef = useRef(reviewContext);
  reviewContextRef.current = reviewContext;
  const lastSentContextRef = useRef<string | undefined>(undefined);
  const identityRef = useRef({ patch, diffType, base });
  identityRef.current = { patch, diffType, base };

  const ask = useCallback(
    (params: AskAIParams) => {
      if (sessionBridge) {
        // The session wrote (or can read) the changes; a pasted patch would stay
        // in its context window for good. A later switch to a separate AI starts
        // a fresh session, which gets the full context below.
        lastSentContextRef.current = undefined;
        const contextPreamble = buildSessionReviewIdentity(identityRef.current);
        return chat.ask({ viewing: viewingRef.current, contextPreamble, ...params });
      }
      const ctx = reviewContextRef.current;
      // Send the full context when this question starts a fresh underlying
      // session (first message, or after a provider/model switch — resetSession
      // nulls sessionId but keeps messages, so a string-only diff would miss it)
      // or when the viewed changeset itself changed.
      const freshSession = !chat.sessionId;
      const changed = freshSession || (ctx ?? '') !== (lastSentContextRef.current ?? '');
      const contextPreamble = buildReviewContextPreamble(ctx, { changed });
      lastSentContextRef.current = ctx;
      return chat.ask({ viewing: viewingRef.current, contextPreamble, ...params });
    },
    [chat, sessionBridge],
  );

  // Re-asking on a separate provider starts a fresh session there, so it gets
  // the full "changes under review" block instead of the bridge's identity.
  const retry = useCallback(
    (questionId: string, options: AIRetryOptions = {}) => {
      if (!options.providerId) return chat.retry(questionId, options);
      const ctx = reviewContextRef.current;
      lastSentContextRef.current = ctx;
      return chat.retry(questionId, {
        ...options,
        params: { ...options.params, contextPreamble: buildReviewContextPreamble(ctx, { changed: true }) },
      });
    },
    [chat],
  );

  return { ...chat, ask, retry };
}
