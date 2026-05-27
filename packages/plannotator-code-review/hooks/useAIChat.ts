import { useState, useCallback, useRef, useEffect } from 'react';
import type { AIQuestion, AIResponse } from '@plannotator/ui/types';
import { generateId } from '../utils/generateId';
import { useSessionFetch } from '@plannotator/ui/hooks/useSessionFetch';
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

interface UseAIChatOptions {
  patch: string;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

interface AskParams {
  prompt: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
}

export function useAIChat({ patch, providerId, model, reasoningEffort }: UseAIChatOptions) {
  const fetch = useSessionFetch();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIChatEntry[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PendingPermission[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Keep ref in sync for use inside async callbacks
  sessionIdRef.current = sessionId;

  const createSession = useCallback(async (signal: AbortSignal): Promise<string> => {
    setIsCreatingSession(true);
    try {
      const res = await fetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            mode: 'code-review',
            review: { patch },
          },
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
      setSessionId(data.sessionId);
      return data.sessionId;
    } finally {
      setIsCreatingSession(false);
    }
  }, [patch, providerId, model, reasoningEffort]);

  const ask = useCallback(async (params: AskParams) => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);

    const questionId = generateId();
    const question: AIQuestion = {
      id: questionId,
      prompt: params.prompt,
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

    // Add the message pair immediately so the UI shows the question
    setMessages(prev => [...prev, { question, response }]);
    setIsStreaming(true);

    try {
      // Lazy session creation
      let sid = sessionIdRef.current;
      if (!sid) {
        sid = await createSession(controller.signal);
      }

      // Build the prompt with context based on scope
      let fullPrompt = params.prompt;
      if (params.filePath && params.lineStart != null && params.lineEnd != null) {
        // Line-scoped
        const lineRef = params.lineStart === params.lineEnd
          ? `line ${params.lineStart}`
          : `lines ${params.lineStart}-${params.lineEnd}`;
        const sideLabel = params.side === 'new' ? 'new (added)' : 'old (removed)';
        const codeBlock = params.selectedCode
          ? `\n\`\`\`\n${params.selectedCode}\n\`\`\`\n`
          : '';
        fullPrompt = `Re: ${params.filePath}, ${lineRef} (${sideLabel} side)${codeBlock}\n${params.prompt}`;
      } else if (params.filePath) {
        // File-scoped
        fullPrompt = `Re: ${params.filePath} (entire file)\n\n${params.prompt}`;
      }
      // else: general — use prompt as-is

      // Start SSE stream
      const res = await fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, prompt: fullPrompt }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: 'Query failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Parse SSE stream
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
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, text: m.response.text + msg.delta } }
                    : m
                )
              );
            } else if (msg.type === 'text') {
              // Complete text from assistant message — only use if we have no
              // streaming content yet (deltas already accumulated the same text).
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId && !m.response.text
                    ? { ...m, response: { ...m.response, text: msg.text } }
                    : m
                )
              );
            } else if (msg.type === 'permission_request') {
              setPermissionRequests(prev => [...prev, {
                requestId: msg.requestId,
                toolName: msg.toolName,
                toolInput: msg.toolInput,
                title: msg.title,
                displayName: msg.displayName,
                description: msg.description,
                toolUseId: msg.toolUseId,
              }]);
            } else if (msg.type === 'error') {
              setMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, error: msg.error, isStreaming: false } }
                    : m
                )
              );
              setError(msg.error);
            } else if (msg.type === 'result') {
              setMessages(prev =>
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
            // Skip unparseable lines
          }
        }
      }

      // Finalize if not already done
      setMessages(prev =>
        prev.map(m =>
          m.question.id === questionId && m.response.isStreaming
            ? { ...m, response: { ...m.response, isStreaming: false } }
            : m
        )
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;

      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages(prev =>
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
  }, [createSession]);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }
    // Also tell the server to abort
    if (sessionIdRef.current) {
      fetch('/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      }).catch(() => {});
    }
  }, []);

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (!sessionIdRef.current) return;

    // Update the permission request state
    setPermissionRequests(prev =>
      prev.map(p => p.requestId === requestId ? { ...p, decided: allow ? 'allow' : 'deny' } : p)
    );

    // Send the decision to the server
    fetch('/api/ai/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        requestId,
        allow,
      }),
    }).catch(() => {});
  }, []);

  const resetSession = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSessionId(null);
    setIsStreaming(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    messages,
    isCreatingSession,
    isStreaming,
    error,
    permissionRequests,
    respondToPermission,
    ask,
    abort,
    resetSession,
    sessionId,
  };
}
