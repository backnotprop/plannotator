import { useCallback, useRef } from 'react';
import {
  useAIChat as useSharedAIChat,
  type AIChatEntry,
  type AskAIParams,
  type PendingPermission,
} from '@plannotator/ui/hooks/useAIChat';
import { buildReviewContextPreamble } from '@plannotator/ui/utils/aiPrompt';
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

  const ask = useCallback(
    (params: AskAIParams) => {
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
    [chat],
  );

  return { ...chat, ask };
}
