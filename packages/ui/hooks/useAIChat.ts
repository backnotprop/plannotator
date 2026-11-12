import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIContext } from '@plannotator/core';
import type { AIQuestion, AIResponse } from '../types';
import { generateId } from '../utils/generateId';
import { SESSION_ASK_ERROR_CODES } from '../utils/aiProvider';

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
  displayPrompt?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
  scope?: AIQuestion['scope'];
  contextUpdate?: string;
  viewing?: { scope: 'all' | 'file'; filePath?: string };
  contextPreamble?: string;
  busyPolicy?: 'wait' | 'interrupt';
  draftAnnotations?: string;
  onDelivered?: () => void;
}

export function draftAnnotationsToSend(
  delivered: { sessionId: string; text: string } | null,
  sessionId: string,
  current: string | undefined,
): string | undefined {
  if (current === undefined) return undefined;
  const seen = delivered?.sessionId === sessionId ? delivered.text : '';
  return current === seen ? undefined : current;
}

const BRIDGE_DRAFTS_KEY = 'session-bridge';

const DELIVERED_MESSAGE_TYPES = new Set(['text_delta', 'text', 'tool_use', 'tool_result', 'result']);

export function hasPendingBusyChoice(messages: AIChatEntry[]): boolean {
  return messages.some(m => m.response.errorCode === SESSION_ASK_ERROR_CODES.agentBusy);
}

export interface AIRetryOptions {
  busyPolicy?: 'wait' | 'interrupt';
  providerId?: string;
  params?: Partial<AskAIParams>;
}

interface UseAIChatOptions {
  context: AIContext | null;
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  buildPrompt?: (params: AskAIParams) => string;
  threadTitle?: string;
}

function selectionLinesLabel(lineStart: unknown, lineEnd: unknown): string | null {
  if (typeof lineStart !== 'number' || !Number.isInteger(lineStart) || lineStart < 1) return null;
  const end = typeof lineEnd === 'number' && Number.isInteger(lineEnd) && lineEnd > lineStart
    ? lineEnd
    : lineStart;
  return end === lineStart ? `line ${lineStart}` : `lines ${lineStart}–${end}`;
}

export function buildDefaultPrompt(params: AskAIParams): string {
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
      const lines = selectionLinesLabel(params.scope.lineStart, params.scope.lineEnd);
      const sourceParts = [params.scope.sourcePath, lines].filter(Boolean);
      const source = sourceParts.length > 0 ? `\nSource: ${sourceParts.join(', ')}` : '';
      const selection = params.scope.text ? `\n\nSelected text:\n\`\`\`\n${params.scope.text}\n\`\`\`` : '';
      const detail = params.scope.detail?.trim() ? `\n\nSelected element:\n${params.scope.detail.trim()}` : '';
      return `${label}${source}${selection}${detail}\n\n${params.prompt}`;
    }

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

export interface AITransport {
  session(body: unknown, signal: AbortSignal): Promise<Response>;
  query(body: unknown, signal: AbortSignal): Promise<Response>;
  abort(body: unknown): Promise<unknown>;
  permission(body: unknown): void;
}

const defaultAITransport: AITransport = {
  session: (body, signal) =>
    fetch('/api/ai/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  query: (body, signal) =>
    fetch('/api/ai/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  abort: (body) =>
    fetch('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {}),
  permission: (body) => {
    fetch('/api/ai/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  },
};

let aiTransport: AITransport = defaultAITransport;

export const setAITransport = (transport: AITransport): void => {
  aiTransport = transport;
};

export const resetAITransport = (): void => {
  aiTransport = defaultAITransport;
};

function safeAbort(sessionId: string, reason?: 'supersede'): Promise<unknown> {
  return Promise.resolve()
    .then(() => aiTransport.abort({ sessionId, ...(reason && { reason }) }))
    .catch(() => {});
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
  const pendingAbortRef = useRef<Promise<unknown> | null>(null);
  const supersededRef = useRef(new WeakSet<AbortController>());
  const sessionEpochRef = useRef(0);
  const createRequestRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = thread.sessionId;
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const updateMessages = useCallback((updater: (messages: AIChatEntry[]) => AIChatEntry[]) => {
    setThread(prev => ({ ...prev, messages: updater(prev.messages) }));
  }, []);

  const updatePermissions = useCallback((updater: (permissions: PendingPermission[]) => PendingPermission[]) => {
    setThread(prev => ({ ...prev, permissionRequests: updater(prev.permissionRequests) }));
  }, []);

  const setSessionId = useCallback((sessionId: string | null) => {
    sessionIdRef.current = sessionId;
    setThread(prev => ({ ...prev, sessionId }));
  }, []);

  const createSession = useCallback(async (signal: AbortSignal, epoch: number, providerOverride?: string): Promise<string> => {
    if (!context) {
      throw new Error('AI context is unavailable');
    }

    const requestId = ++createRequestRef.current;
    setIsCreatingSession(true);
    try {
      const res = await aiTransport.session(providerOverride ? {
        context,
        providerId: providerOverride,
      } : {
        context,
        ...(providerId && { providerId }),
        ...(model && { model }),
        ...(reasoningEffort && { reasoningEffort }),
      }, signal);

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create AI session' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json() as { sessionId: string };
      if (signal.aborted || epoch !== sessionEpochRef.current) {
        void safeAbort(data.sessionId);
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

  const postServerAbort = useCallback((reason?: 'supersede'): Promise<unknown> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return Promise.resolve();
    return safeAbort(sessionId, reason);
  }, []);

  const paramsByQuestionRef = useRef(new Map<string, AskAIParams>());
  const deliveredDraftsRef = useRef<{ sessionId: string; text: string } | null>(null);

  const ask = useCallback(async (params: AskAIParams, askOptions?: { providerId?: string }) => {
    const previous = abortRef.current;
    if (previous) {
      supersededRef.current.add(previous);
      pendingAbortRef.current = postServerAbort('supersede');
    }
    if (pendingAbortRef.current) {
      await pendingAbortRef.current;
      pendingAbortRef.current = null;
    }
    previous?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    const epoch = sessionEpochRef.current;
    setError(null);

    const questionId = generateId('ai-question');
    paramsByQuestionRef.current.set(questionId, params);
    const question: AIQuestion = {
      id: questionId,
      prompt: params.displayPrompt ?? params.prompt,
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
      if (askOptions?.providerId) {
        sid = await createSession(controller.signal, epoch, askOptions.providerId);
      } else if (!sid) {
        sid = await createSession(controller.signal, epoch);
      }

      if (controller.signal.aborted || supersededRef.current.has(controller) || epoch !== sessionEpochRef.current) {
        throw createAbortError('AI question was superseded');
      }

      const fullPrompt = buildPrompt(params);
      const drafts = draftAnnotationsToSend(deliveredDraftsRef.current, BRIDGE_DRAFTS_KEY, params.draftAnnotations);
      let deliveredCalled = false;
      const markDraftsDelivered = (msg: { type?: unknown; code?: unknown }) => {
        const received = DELIVERED_MESSAGE_TYPES.has(String(msg.type))
          || (msg.type === 'error' && msg.code === SESSION_ASK_ERROR_CODES.takenOver);
        if (!received) return;
        if (drafts !== undefined) deliveredDraftsRef.current = { sessionId: BRIDGE_DRAFTS_KEY, text: drafts };
        if (!deliveredCalled) {
          deliveredCalled = true;
          try {
            params.onDelivered?.();
          } catch {
          }
        }
      };
      const res = await aiTransport.query({
        sessionId: sid,
        prompt: fullPrompt,
        ...(params.contextUpdate && { contextUpdate: params.contextUpdate }),
        ...(params.busyPolicy && { busyPolicy: params.busyPolicy }),
        ...(drafts !== undefined && { draftAnnotations: drafts }),
      }, controller.signal);

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: 'Query failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (supersededRef.current.has(controller)) throw createAbortError('AI question was superseded');
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
            markDraftsDelivered(msg);

            if (msg.type === 'text_delta') {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: m.response.status
                        ? { ...m.response, text: m.response.text + msg.delta, status: undefined }
                        : { ...m.response, text: m.response.text + msg.delta } }
                    : m
                )
              );
            } else if (msg.type === 'status') {
              const status = msg.status === 'waiting' || msg.status === 'interrupting' ? msg.status : undefined;
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? { ...m, response: { ...m.response, status } }
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
            } else if (msg.type === 'error' && msg.code === SESSION_ASK_ERROR_CODES.takenOver) {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? {
                        ...m,
                        response: {
                          ...m.response,
                          notice: typeof msg.error === 'string' ? msg.error : undefined,
                          ...(m.response.status && { status: undefined }),
                          isStreaming: false,
                        },
                      }
                    : m
                )
              );
            } else if (msg.type === 'error') {
              updateMessages(prev =>
                prev.map(m =>
                  m.question.id === questionId
                    ? {
                        ...m,
                        response: {
                          ...m.response,
                          error: msg.error,
                          ...(typeof msg.code === 'string' && { errorCode: msg.code }),
                          ...(m.response.status && { status: undefined }),
                          isStreaming: false,
                        },
                      }
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
          }
        }
      }

      updateMessages(prev =>
        prev.map(m =>
          m.question.id === questionId && (m.response.isStreaming || m.response.status)
            ? { ...m, response: { ...m.response, isStreaming: false, ...(m.response.status && { status: undefined }) } }
            : m
        )
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        updateMessages(prev =>
          prev.map(m =>
            m.question.id === questionId
              ? { ...m, response: { ...m.response, isStreaming: false, ...(m.response.status && { status: undefined }) } }
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
      if (abortRef.current === controller && !supersededRef.current.has(controller)) {
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }, [buildPrompt, createSession, updateMessages, updatePermissions, postServerAbort]);

  const retry = useCallback((questionId: string, options: AIRetryOptions = {}) => {
    const original = paramsByQuestionRef.current.get(questionId);
    if (!original) return;
    paramsByQuestionRef.current.delete(questionId);
    updateMessages(prev => prev.filter(m => m.question.id !== questionId));
    const { busyPolicy: _previousPolicy, ...base } = original;
    const params: AskAIParams = {
      ...base,
      ...options.params,
      ...(options.busyPolicy && { busyPolicy: options.busyPolicy }),
    };
    return ask(params, options.providerId ? { providerId: options.providerId } : undefined);
  }, [ask, updateMessages]);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsStreaming(false);
    }

    updatePermissions(prev => prev.filter(p => p.decided));

    pendingAbortRef.current = postServerAbort();
  }, [updatePermissions, postServerAbort]);

  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (!sessionIdRef.current) return;

    updatePermissions(prev =>
      prev.map(p => p.requestId === requestId ? { ...p, decided: allow ? 'allow' : 'deny' } : p)
    );

    aiTransport.permission({
      sessionId: sessionIdRef.current,
      requestId,
      allow,
    });
  }, [updatePermissions]);

  const resetSession = useCallback(() => {
    sessionEpochRef.current += 1;
    createRequestRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      pendingAbortRef.current = postServerAbort();
    }
    setSessionId(null);
    setIsCreatingSession(false);
    setIsStreaming(false);
  }, [postServerAbort, setSessionId]);

  const resetThread = useCallback(() => {
    sessionEpochRef.current += 1;
    createRequestRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      pendingAbortRef.current = postServerAbort();
    }
    paramsByQuestionRef.current.clear();
    setThread(createThread(threadTitle));
    setIsCreatingSession(false);
    setIsStreaming(false);
    setError(null);
  }, [postServerAbort, threadTitle]);

  const newChat = useCallback((): boolean => {
    if (abortRef.current) return false;
    if (hasPendingBusyChoice(threadRef.current.messages)) return false;
    resetThread();
    return true;
  }, [resetThread]);

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
    retry,
    abort,
    resetSession,
    resetThread,
    newChat,
    sessionId: thread.sessionId,
  };
}
