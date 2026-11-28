import type { AIChatThread, AskAIParams } from '../hooks/useAIChat';
import type { AIQuestion, AIResponse } from '../types';

type RetryParams = Omit<AskAIParams, 'onDelivered'>;

export interface AIChatSnapshot {
  version: 1;
  thread: AIChatThread;
  paramsByQuestion: Array<[string, RetryParams]>;
  deliveredDrafts: { sessionId: string; text: string } | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every(field => value[field] === undefined || typeof value[field] === 'string');
}

function optionalLines(value: Record<string, unknown>): boolean {
  return ['lineStart', 'lineEnd'].every(field => value[field] === undefined || Number.isInteger(value[field]));
}

function validScope(value: unknown): value is AIQuestion['scope'] {
  return value === undefined || (record(value)
    && (value.kind === 'general' || value.kind === 'selection')
    && optionalStrings(value, ['label', 'text', 'sourcePath', 'detail']) && optionalLines(value));
}

function validParams(value: unknown): value is RetryParams {
  return record(value) && typeof value.prompt === 'string'
    && optionalStrings(value, ['displayPrompt', 'filePath', 'selectedCode', 'contextUpdate', 'contextPreamble', 'draftAnnotations'])
    && optionalLines(value) && validScope(value.scope)
    && (value.side === undefined || value.side === 'old' || value.side === 'new')
    && (value.busyPolicy === undefined || value.busyPolicy === 'wait' || value.busyPolicy === 'interrupt')
    && (value.viewing === undefined || (record(value.viewing)
      && (value.viewing.scope === 'all' || value.viewing.scope === 'file')
      && optionalStrings(value.viewing, ['filePath'])));
}

function validQuestion(value: unknown): value is AIQuestion {
  return record(value) && typeof value.id === 'string' && typeof value.createdAt === 'number' && validParams(value);
}

function validResponse(value: unknown): value is AIResponse {
  return record(value) && typeof value.questionId === 'string' && typeof value.text === 'string'
    && typeof value.isStreaming === 'boolean' && typeof value.createdAt === 'number'
    && optionalStrings(value, ['error', 'errorCode', 'notice'])
    && (value.status === undefined || value.status === 'waiting' || value.status === 'interrupting');
}

/** A tab's transcript belongs to one running server, not to a port's next server. */
export function aiChatStorageKey(serverSession: string | null, surface: 'editor' | 'review'): string | null {
  return serverSession ? `plannotator-ai-chat:${surface}:${serverSession}` : null;
}

/** Browser storage can be unavailable, full or left over from another version. */
export function readAIChatSnapshot(key: string | null): AIChatSnapshot | null {
  if (!key) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !record(value.thread)) return null;
    const { thread } = value;
    if (typeof thread.id !== 'string' || typeof thread.title !== 'string'
      || (thread.sessionId !== null && typeof thread.sessionId !== 'string') || !Array.isArray(thread.messages)) return null;
    const messages = [];
    for (const entry of thread.messages) {
      if (!record(entry) || !validQuestion(entry.question) || !validResponse(entry.response)
        || entry.response.questionId !== entry.question.id) return null;
      // The old SSE connection is gone. Keep its partial answer without a
      // spinner or waiting status; permission cards cannot be answered now.
      const interrupted = entry.response.isStreaming || entry.response.status !== undefined;
      messages.push({
        question: entry.question,
        response: {
          ...entry.response,
          isStreaming: false,
          status: undefined,
          ...(interrupted && !entry.response.error && { notice: 'Answer stopped when the page was reloaded.' }),
        },
      });
    }
    if (!Array.isArray(value.paramsByQuestion)) return null;
    const paramsByQuestion: AIChatSnapshot['paramsByQuestion'] = [];
    for (const entry of value.paramsByQuestion) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !validParams(entry[1])) return null;
      const { onDelivered: _callback, ...params } = entry[1] as AskAIParams;
      paramsByQuestion.push([entry[0], params]);
    }
    // A displayed question can be shorter than its actual prompt. Never
    // restore an unretryable busy choice that also prevents starting a chat.
    const retryIds = new Set(paramsByQuestion.map(([id]) => id));
    if (messages.some(({ question }) => !retryIds.has(question.id))) return null;
    const deliveredDrafts = value.deliveredDrafts;
    if (deliveredDrafts !== null && (!record(deliveredDrafts)
      || typeof deliveredDrafts.sessionId !== 'string' || typeof deliveredDrafts.text !== 'string')) return null;
    return {
      version: 1,
      thread: { id: thread.id, title: thread.title, sessionId: typeof thread.sessionId === 'string' ? thread.sessionId : null, messages, permissionRequests: [] },
      paramsByQuestion,
      deliveredDrafts: deliveredDrafts as AIChatSnapshot['deliveredDrafts'],
    };
  } catch {
    return null;
  }
}

export function writeAIChatSnapshot(
  key: string | null,
  thread: AIChatThread,
  paramsByQuestion: Map<string, AskAIParams>,
  deliveredDrafts: AIChatSnapshot['deliveredDrafts'],
): void {
  if (!key) return;
  try {
    const snapshot: AIChatSnapshot = {
      version: 1,
      thread: { ...thread, permissionRequests: [] },
      paramsByQuestion: thread.messages.flatMap(({ question }) => {
        const params = paramsByQuestion.get(question.id);
        if (!params) return [];
        const { onDelivered: _callback, ...serializable } = params;
        return [[question.id, serializable] as [string, RetryParams]];
      }),
      deliveredDrafts,
    };
    window.sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Persistence must never prevent asking, stopping or starting a new chat.
    // A full storage keeps the last snapshot that fit; drop it, so a reload
    // never shows an older chat with its latest answers missing.
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage is unavailable altogether.
    }
  }
}
