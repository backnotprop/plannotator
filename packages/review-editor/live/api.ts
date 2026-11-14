import { withServerSession } from '@plannotator/ui/utils/serverSession';
import type { InboxReviewAnchor } from '@plannotator/core/review-threads';
import type { LiveAgent, LiveState, LiveTarget } from './model';

export class LiveError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw new LiveError(response.status, body.code ?? 'error', body.error ?? 'The Inbox did not answer.');
  return body;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface LiveSendTag extends LiveTarget {
  label?: string;
}

export const liveApi = {
  state: () => call<LiveState>('/api/live/state'),
  agents: () => call<{ agents: LiveAgent[]; launched_by: LiveTarget | null }>('/api/live/agents'),
  send: (input: { comments: { anchor: InboxReviewAnchor; words: string }[]; words?: string; to?: LiveTarget; tags?: LiveSendTag[]; idempotency_key: string }) =>
    post<{ sent: string[] }>('/api/live/send', input),
  reply: (messageId: string, input: { words: string; tags?: LiveSendTag[]; idempotency_key: string }) => post<{ reply: { id: string } }>(`/api/live/reply/${messageId}`, input),
  resolve: (messageId: string, resolved: boolean) => post<unknown>(`/api/live/resolve/${messageId}`, { resolved }),
  sendNow: (messageId: string) => post<unknown>(`/api/live/send-now/${messageId}`, {}),
  takeBack: (messageId: string) => post<{ taken: string[] }>(`/api/live/take-back/${messageId}`, {}),
};

export async function postThreadsToPR(input: { action: 'comment'; body: string; fileComments: unknown[]; fileLevelComments: unknown[] }): Promise<{ prUrl?: string }> {
  const response = await fetch('/api/pr-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withServerSession(input)) });
  const answer = (await response.json().catch(() => ({}))) as { error?: string; prUrl?: string; submission?: { status?: string } };
  if (!response.ok) throw new LiveError(response.status, 'pr_action', answer.error ?? 'The review was not posted.');
  return answer;
}

export function liveKey(): string {
  return `rv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function liveRecordTouches(data: string, threadId: string | null): boolean {
  try {
    const line = JSON.parse(data) as { kind?: string; message?: { thread_id?: string } };
    if (line.kind !== 'message') return false;
    return threadId === null || line.message?.thread_id === threadId;
  } catch {
    return false;
  }
}

export function watchLive(threadId: () => string | null, onChange: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource('/api/live/events');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const nudge = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 200);
  };
  source.addEventListener('record', (event) => {
    if (liveRecordTouches((event as MessageEvent<string>).data, threadId())) nudge();
  });
  source.addEventListener('deliveries', nudge);
  return () => {
    if (timer) clearTimeout(timer);
    source.close();
  };
}
