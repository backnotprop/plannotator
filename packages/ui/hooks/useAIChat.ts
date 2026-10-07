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
  /** "Ask this session" only: what to do when the host session is busy
   *  ("wait" = ask when it finishes, "interrupt" = stop its turn and ask now). */
  busyPolicy?: 'wait' | 'interrupt';
  /** "Ask this session" only: the reviewer's CURRENT unsubmitted annotations
   *  as a plain list (`formatDraftAnnotationsForAsk`; '' when there are none).
   *  The hook sends it only when it differs from what this session last
   *  received, and the server frames it as read-only context, never as
   *  feedback (#1748). Leave unset for every other provider. */
  draftAnnotations?: string;
}

/** What to send as `draftAnnotations` for one question: the list when this
 *  session has not received it yet, '' once to clear drafts it saw earlier,
 *  nothing when it already has the current list. */
export function draftAnnotationsToSend(
  delivered: { sessionId: string; text: string } | null,
  sessionId: string,
  current: string | undefined,
): string | undefined {
  if (current === undefined) return undefined;
  const seen = delivered?.sessionId === sessionId ? delivered.text : '';
  return current === seen ? undefined : current;
}

/** `draftAnnotationsToSend` key for "Ask this session": one host session per page. */
const BRIDGE_DRAFTS_KEY = 'session-bridge';

/** Stream messages that show the session received the question. */
const DELIVERED_MESSAGE_TYPES = new Set(['text_delta', 'text', 'tool_use', 'tool_result', 'result']);

/** Overrides for re-asking a question that ended in a busy/gone/blocked answer. */
export interface AIRetryOptions {
  busyPolicy?: 'wait' | 'interrupt';
  /** Ask a different provider instead (a fresh session is created for it). */
  providerId?: string;
  /** Replace parts of the original question (e.g. a provider-specific preamble). */
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

/** `line 41` / `lines 41–44` (the export's spelling) for a selection's
 *  source lines; `null` when the scope carries no valid line. */
function selectionLinesLabel(lineStart: unknown, lineEnd: unknown): string | null {
  if (typeof lineStart !== 'number' || !Number.isInteger(lineStart) || lineStart < 1) return null;
  const end = typeof lineEnd === 'number' && Number.isInteger(lineEnd) && lineEnd > lineStart
    ? lineEnd
    : lineStart;
  return end === lineStart ? `line ${lineStart}` : `lines ${lineStart}–${end}`;
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
      const lines = selectionLinesLabel(params.scope.lineStart, params.scope.lineEnd);
      const sourceParts = [params.scope.sourcePath, lines].filter(Boolean);
      const source = sourceParts.length > 0 ? `\nSource: ${sourceParts.join(', ')}` : '';
      const selection = params.scope.text ? `\n\nSelected text:\n\`\`\`\n${params.scope.text}\n\`\`\`` : '';
      const detail = params.scope.detail?.trim() ? `\n\nSelected element:\n${params.scope.detail.trim()}` : '';
      return `${label}${source}${selection}${detail}\n\n${params.prompt}`;
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

/**
 * Transport for the AI chat wire. Each method maps to one Plannotator
 * `/api/ai/*` endpoint. The default reproduces today's fetches verbatim;
 * a host (e.g. Workspaces) calls `setAITransport` once at startup to route
 * AI traffic through its own backend. The SSE reader loop, epoch guards, and
 * supersede-abort position in the hook are unaffected — only the wire is swapped.
 */
export interface AITransport {
  /** POST /api/ai/session — create or fork a session. */
  session(body: unknown, signal: AbortSignal): Promise<Response>;
  /** POST /api/ai/query — send a message; returns the streaming SSE response. */
  query(body: unknown, signal: AbortSignal): Promise<Response>;
  /** POST /api/ai/abort — abort a session (supersede + standalone). Resolves once
      the server acknowledges so a following query can await it (best-effort, never rejects). */
  abort(body: unknown): Promise<unknown>;
  /** POST /api/ai/permission — respond to a permission request. Fire-and-forget. */
  permission(body: unknown): void;
}

/** Default transport — Plannotator's local `/api/ai/*` fetches, verbatim. */
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

// Module-level transport, stable identity. Defaults to Plannotator's behavior so
// the hook and its callers are unchanged. A host overrides it once at startup.
let aiTransport: AITransport = defaultAITransport;

/** Override the AI chat transport. Call once at app startup. */
export const setAITransport = (transport: AITransport): void => {
  aiTransport = transport;
};

/** Reset to the default (Plannotator local `/api/ai/*`) transport. Mainly for tests. */
export const resetAITransport = (): void => {
  aiTransport = defaultAITransport;
};

/**
 * Dispatch the abort transport without ever rejecting. A host transport whose
 * `abort` throws — synchronously (deferred into `.then`) or asynchronously
 * (`.catch`) — must not surface as an unhandled rejection, and the await site in
 * ask() relies on this resolving. Single-sourced so every abort call site stays
 * hardened. Reads `aiTransport` at call time so a late override is honored.
 */
function safeAbort(sessionId: string): Promise<unknown> {
  return Promise.resolve()
    .then(() => aiTransport.abort({ sessionId }))
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
        void safeAbort(data.sessionId); // fire-and-forget cleanup of the orphaned session
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
    const sessionId = sessionIdRef.current; // capture the session being aborted now
    if (!sessionId) return Promise.resolve();
    return safeAbort(sessionId);
  }, []);

  // The params each question was asked with, so a busy answer can be
  // re-asked ("Ask when it finishes", "Interrupt and ask now").
  const paramsByQuestionRef = useRef(new Map<string, AskAIParams>());
  // The draft list the agent session last RECEIVED, so an unchanged list is
  // not pasted into it again on every question. Kept for the page, not per
  // Plannotator AI session: every Ask AI session (a new thread, a document
  // switch in a folder or bundle) reaches the SAME host agent session through
  // the bridge, which keeps what it already read. Per AI session, a new thread
  // re-sent the whole list, and drafts cleared after one never reached the
  // session as cleared.
  const deliveredDraftsRef = useRef<{ sessionId: string; text: string } | null>(null);

  const ask = useCallback(async (params: AskAIParams, askOptions?: { providerId?: string }) => {
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
    paramsByQuestionRef.current.set(questionId, params);
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
      if (askOptions?.providerId) {
        sid = await createSession(controller.signal, epoch, askOptions.providerId);
      } else if (!sid) {
        sid = await createSession(controller.signal, epoch);
      }

      if (controller.signal.aborted || epoch !== sessionEpochRef.current) {
        throw createAbortError('AI question was superseded');
      }

      const fullPrompt = buildPrompt(params);
      const drafts = draftAnnotationsToSend(deliveredDraftsRef.current, BRIDGE_DRAFTS_KEY, params.draftAnnotations);
      // Recorded once the session shows it received the question, so a busy,
      // gone or failed ask sends the list again next time.
      const markDraftsDelivered = (msg: { type?: unknown; code?: unknown }) => {
        if (drafts === undefined) return;
        const received = DELIVERED_MESSAGE_TYPES.has(String(msg.type))
          || (msg.type === 'error' && msg.code === SESSION_ASK_ERROR_CODES.takenOver);
        if (received) deliveredDraftsRef.current = { sessionId: BRIDGE_DRAFTS_KEY, text: drafts };
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
              // "Ask this session": waiting on / interrupting a busy session.
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
              // "Ask this session": the person typed into the session while it
              // answered. The answer so far stands; the reason is a note under
              // it, not an error that would replace it.
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
            // Ignore malformed SSE lines.
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
      if (abortRef.current === controller) {
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }, [buildPrompt, createSession, updateMessages, updatePermissions, postServerAbort]);

  /**
   * Re-ask an earlier question in place of its answer: the busy-session choice
   * ("Ask when it finishes" / "Interrupt and ask now"). `providerId` re-asks
   * on another provider for hosts that offer one.
   */
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
    sessionId: thread.sessionId,
  };
}
