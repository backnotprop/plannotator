import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIContext } from '@plannotator/ai';
import type { AIQuestion, AIResponse } from '../types';
import { generateId } from '../utils/generateId';

export interface AIChatEntry {
  question: AIQuestion;
  response: AIResponse;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseId: string;
  decided?: 'allow' | 'deny';
}

export interface AIChatThread {
  id: string;
  title: string;
  sessionId: string | null;
  messages: AIChatEntry[];
  permissionRequests: PendingPermission[];
}

export interface AskAIParams {
  prompt: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
  scope?: AIQuestion['scope'];
  contextUpdate?: string;
  /** What the user is currently viewing (changes mid-session, so it rides with
   *  each question rather than the once-created session context). */
  viewing?: { scope: 'all' | 'file'; filePath?: string };
  /** Context block prepended to the message (e.g. the "changes under review"
   *  description). Rides with each question so it reflects the live view. */
  contextPreamble?: string;
}

interface UseAIChatOptions {
  context: AIContext | null;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  buildPrompt?: (params: AskAIParams) => string;
  threadTitle?: string;
}

export function buildDefaultPrompt(params: AskAIParams): string {
  // The "changes under review" context (and any other preamble) leads the
  // message, so the agent is oriented to the live view before the question and
  // the existing file/line/viewing notes.
  const pre = params.contextPreamble?.trim() ? `${params.contextPreamble.trim()}\n\n` : '';

  const base = ((): string => {
    if (params.filePath && params.lineStart != null && params.lineEnd != null) {
      const lineRef = params.lineStart === params.lineEnd
        ? `line ${params.lineStart}`
        : `lines ${params.lineStart}-${params.lineEnd}`;
      const sideLabel = params.side === 'new' ? 'new (added)' : 'old (removed)';
      const codeBlock = params.selectedCode
        ? `\n\`\`\`\n${params.selectedCode}\n\`\`\`\n`
        : '';
      return `Re: ${params.filePath}, ${lineRef} (${sideLabel} side)${codeBlock}\n${params.prompt}`;
    }

    if (params.filePath) {
      return `Re: ${params.filePath} (entire file)\n\n${params.prompt}`;
    }

    if (params.scope?.kind === 'selection') {
      const label = params.scope.label ? `Re: ${params.scope.label}` : 'Re: selected text';
      const source = params.scope.sourcePath ? `\nSource: ${params.scope.sourcePath}` : '';
      const selection = params.scope.text ? `\n\nSelected text:\n\`\`\`\n${params.scope.text}\n\`\`\`` : '';
      return `${label}${source}${selection}\n\n${params.prompt}`;
    }

    // General question (no explicit file/line/selection): tell the agent what the
    // user is currently looking at so it can scope its own investigation.
    if (params.viewing) {
      const note = params.viewing.scope === 'file' && params.viewing.filePath
        ? `[The user is currently viewing ${params.viewing.filePath}]`
        : '[The user is currently viewing all changed files]';
      return `${note}\n${params.prompt}`;
    }

    return params.prompt;
  })();

  return pre + base;
}

function createThread(title = 'Chat'): AIChatThread {
  return {
    id: generateId('ai-thread'),
    title,
    sessionId: null,
    messages: [],
    permissionRequests: [],
  };
}

function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function useAIChat({
  context,
  providerId,
  model,
  reasoningEffort,
  buildPrompt = buildDefaultPrompt,
  threadTitle = 'Chat',
}: UseAIChatOptions) {
  const [thread, setThread] = useState<AIChatThread>(() => createThread(threadTitle));
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // In-flight server abort (from Stop or a superseding question). The next ask()
  // waits on it so a new query can't race the still-active turn into busy.
  const pendingAbortRef = useRef<Promise<unknown> | null>(null);
  const sessionEpochRef = useRef(0);
  const createRequestRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = thread.sessionId;

  const updateMessages = useCallback((updater: (messages: AIChatEntry[]) => AIChatEntry[]) => {
    setThread(prev => ({ ...prev, messages: updater(prev.messages) }));
  }, []);

  const updatePermissions = useCallback((updater: (permissions: PendingPermission[]) => PendingPermission[]) => {
    setThread(prev => ({ ...prev, permissionRequests: updater(prev.permissionRequests) }));
  }, []);

  const setSessionId = useCallback((sessionId: string | null) => {
    setThread(prev => ({ ...prev, sessionId }));
  }, []);

  const createSession = useCallback(async (signal: AbortSignal, epoch: number): Promise<string> => {
    if (!context) {
      throw new Error('AI context is unavailable');
    }

    const requestId = ++createRequestRef.current;
    setIsCreatingSession(true);
    try {
      const res = await fetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context,
          ...(providerId && { providerId }),
          ...(model && { model }),
          ...(reasoningEffort && { reasoningEffort }),
        }),
        signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create AI session' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json() as { sessionId: string };
      if (signal.aborted || epoch !== sessionEpochRef.current) {
        fetch('/api/ai/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: data.sessionId }),
        }).catch(() => {});
        throw createAbortError('AI session creation was superseded');
      }
      setSessionId(data.sessionId);
      return data.sessionId;
    } finally {
      if (createRequestRef.current === requestId) {
        setIsCreatingSession(false);
      }
    }
  }, [context, model, providerId, reasoningEffort, setSessionId]);

  // Tell the server to stop the current session's in-flight turn, and resolve
  // once it has. Used by the Stop button and when a new question supersedes a
  // streaming one — aborting the browser fetch alone leaves the agent's turn
  // running. The /api/ai/abort handler clears the session's active flag before
  // it responds, so awaiting this guarantees a following query won't race it
  // into a session_busy error. Best-effort (never rejects).
  const postServerAbort = useCallback((): Promise<unknown> => {
    if (!sessionIdRef.current) return Promise.resolve();
    return fetch('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdRef.current }),
    }).catch(() => {});
  }, []);

  const ask = useCallback(async (params: AskAIParams) => {
    if (abortRef.current) {
      abortRef.current.abort();
      // Supersede: stop the server-side turn (not just the browser fetch).
      pendingAbortRef.current = postServerAbort();
    }
    // Wait for any in-flight server abort — from this supersede OR a prior Stop
    // click — so the query below doesn't race the still-active turn into a
    // session_busy error. Stopping still kills the turn; chatting right after
    // just waits the one round-trip for the stop to land.
    if (pendingAbortRef.current) {
      await pendingAbortRef.current;
      pendingAbortRef.current = null;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const epoch = sessionEpochRef.current;
    setError(null);

    const questionId = generateId('ai-question');
    const question: AIQuestion = {
      id: questionId,
      prompt: params.prompt,
      scope: params.scope,
      filePath: params.filePath,
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      side: params.side,
      selectedCode: params.selectedCode,
      createdAt: Date.now(),
    };

    const response: AIResponse = {
      questionId,
      text: '',
      isStreaming: true,
      createdAt: Date.now(),
    };

    updateMessages(prev => [...prev, { question, response }]);
    setIsStreaming(true);

    try {
      let sid = sessionIdRef.current;
      if (!sid) {
        sid = await createSession(controller.signal, epoch);
      }

      if (controller.signal.aborted || epoch !== sessionEpochRef.current) {
        throw createAbortError('AI question was superseded');
      }

      const fullPrompt = buildPrompt(params);
      const res = await fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sid,
          prompt: fullPrompt,
          ...(params.contextUpdate && { contextUpdate: params.contextUpdate }),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: 'Query failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const msg = JSON.parse(data);

            if (msg.type === 'text_delta') {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, text: m.response.text + msg.delta } }
                    : m
                )
              );
            } else if (msg.type === 'text') {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId && !m.response.text
                    ? { ...m, response: { ...m.response, text: msg.text } }
                    : m
                )
              );
            } else if (msg.type === 'permission_request') {
              updatePermissions(prev => [...prev, {
                requestId: msg.requestId,
                toolName: msg.toolName,
                toolInput: msg.toolInput,
                title: msg.title,
                displayName: msg.displayName,
                description: msg.description,
                toolUseId: msg.toolUseId,
              }]);
            } else if (msg.type === 'error') {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, error: msg.error, isStreaming: false } }
                    : m
                )
              );
              setError(msg.error);
            } else if (msg.type === 'result') {
              updateMessages(prev =>
                prev.map(m => {
                  if (m.question.id !== questionId) return m;
                  const resultText = msg.result ?? '';
                  return {
                    ...m,
                    response: {
                      ...m.response,
                      text: m.response.text || resultText,
                      isStreaming: false,
                    },
                  };
                })
              );
            }
          } catch {
            // Ignore malformed SSE lines.
          }
        }
      }

      updateMessages(prev =>
        prev.map(m =>
          m.question.id === questionId && m.response.isStreaming
            ? { ...m, response: { ...m.response, isStreaming: false } }
            : m
        )
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        updateMessages(prev =>
          prev.map(m =>
            m.question.id === questionId
              ? { ...m, response: { ...m.response, isStreaming: false } }
              : m
          )
        );
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      updateMessages(prev =>
        prev.map(m =>
          m.question.id === questionId
            ? { ...m, response: { ...m.response, error: message, isStreaming: false } }
            : m
        )
      );
    } finally {
      if (abortRef.current === controller) {
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }, [buildPrompt, createSession, updateMessages, updatePermissions, postServerAbort]);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }

    // Drop any still-undecided permission cards: abort cancels them server-side,
    // so leaving them on screen would be a dead Allow/Deny the agent never hears.
    updatePermissions(prev => prev.filter(p => p.decided));

    // Record the abort so a quick follow-up question waits for it (see ask()).
    pendingAbortRef.current = postServerAbort();
  }, [updatePermissions, postServerAbort]);

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (!sessionIdRef.current) return;

    updatePermissions(prev =>
      prev.map(p => p.requestId === requestId ? { ...p, decided: allow ? 'allow' : 'deny' } : p)
    );

    fetch('/api/ai/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        requestId,
        allow,
      }),
    }).catch(() => {});
  }, [updatePermissions]);

  const resetSession = useCallback(() => {
    sessionEpochRef.current += 1;
    createRequestRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSessionId(null);
    setIsCreatingSession(false);
    setIsStreaming(false);
  }, [setSessionId]);

  const resetThread = useCallback(() => {
    sessionEpochRef.current += 1;
    createRequestRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setThread(createThread(threadTitle));
    setIsCreatingSession(false);
    setIsStreaming(false);
    setError(null);
  }, [threadTitle]);

  useEffect(() => {
    return () => {
      sessionEpochRef.current += 1;
      createRequestRef.current += 1;
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    thread,
    messages: thread.messages,
    isCreatingSession,
    isStreaming,
    error,
    permissionRequests: thread.permissionRequests,
    respondToPermission,
    ask,
    abort,
    resetSession,
    resetThread,
    sessionId: thread.sessionId,
  };
}
