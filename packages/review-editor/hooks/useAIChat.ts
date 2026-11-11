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
  diffType?: string;
  base?: string | null;
  reviewContext?: string;
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

  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  // Send the full block when it first appears or changes; a short reminder otherwise (see
  // buildReviewContextPreamble).
  const reviewContextRef = useRef(reviewContext);
  reviewContextRef.current = reviewContext;
  const lastSentContextRef = useRef<string | undefined>(undefined);
  const identityRef = useRef({ patch, diffType, base });
  identityRef.current = { patch, diffType, base };

  const ask = useCallback(
    (params: AskAIParams) => {
      if (sessionBridge) {
        lastSentContextRef.current = undefined;
        const contextPreamble = buildSessionReviewIdentity(identityRef.current);
        return chat.ask({ viewing: viewingRef.current, contextPreamble, ...params });
      }
      const ctx = reviewContextRef.current;
      const freshSession = !chat.sessionId;
      const changed = freshSession || (ctx ?? '') !== (lastSentContextRef.current ?? '');
      const contextPreamble = buildReviewContextPreamble(ctx, { changed });
      lastSentContextRef.current = ctx;
      return chat.ask({ viewing: viewingRef.current, contextPreamble, ...params });
    },
    [chat, sessionBridge],
  );

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
