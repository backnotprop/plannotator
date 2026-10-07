/**
 * The Inbox window's client for its own server (packages/server/inbox.ts).
 * Same origin only; every state-changing call carries the page's
 * `serverSession`, so a tab left open on an older Inbox gets a 409 instead of
 * writing into a store it did not read.
 */

import type {
  InboxHealth,
  InboxListSection,
  InboxMessage,
  InboxProject,
  InboxQuestion,
  InboxThread,
} from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';

export type AgentToolHost = 'claude-code' | 'pi' | 'opencode';

/** The list sections a notification can come from (questions and stops, never news). */
export type NotifySection = 'stopped' | 'holding' | 'waiting';

/** The browser notifications as the Inbox keeps them (config.json, so they survive a port change). */
export interface NotificationSettings {
  enabled: boolean;
  sections: NotifySection[];
  /** The person answered the one-time ask with "Not now". */
  dismissed: boolean;
  /** The page origin where they last turned notifications on. */
  allowed_origin: string | null;
}

export interface ProjectFolder extends InboxProject {
  threads: number;
  unread: number;
}

export interface ListModel {
  serverSession: string;
  version: string;
  cursor: number;
  update: InboxHealth['update'];
  notice: string | null;
  projects: ProjectFolder[];
  project: string | null;
  sections: InboxListSection[];
}

export interface ThreadModel {
  serverSession: string;
  cursor: number;
  thread: InboxThread;
}

export interface SettingsModel {
  serverSession: string;
  version: string;
  port: number;
  url: string;
  mcp_url: string;
  mcp_command: string[];
  home: string;
  data_dir: string;
  inbox_tool: { hosts: Record<AgentToolHost, boolean>; env: boolean | null };
  notifications: NotificationSettings;
  store: {
    dir: string;
    bytes: number;
    projects: {
      id: string;
      name: string;
      root: string;
      bytes: number;
      threads: { thread_id: string; subject: string | null; bytes: number }[];
    }[];
  };
}

export class InboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InboxApiError';
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InboxApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'error',
      typeof body.error === 'string' ? body.error : `The Inbox answered ${response.status}.`,
    );
  }
  return body as T;
}

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
}

/** The serverSession every POST carries; set from the first list read. */
let pageSession: string | null = null;

export function setPageSession(value: string): void {
  if (pageSession === null) pageSession = value;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(pageSession ? { ...body, serverSession: pageSession } : body),
    }),
  );
}

export const inboxApi = {
  list: () => get<ListModel>('/api/inbox/threads'),
  thread: (threadId: string) => get<ThreadModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}`),
  settings: () => get<SettingsModel>('/api/inbox/settings'),
  seen: (threadId: string) => post<unknown>(`/api/inbox/threads/${encodeURIComponent(threadId)}/seen`, {}),
  pick: (messageId: string, key: string, revision: number, answer: QuestionAnswer | null) =>
    post<{ questions: InboxQuestion[] }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/picks`, {
      questions: [{ key, revision, answer }],
    }),
  reply: (messageId: string, input: { idempotency_key: string; words: string; questions: { key: string; revision: number }[] }) =>
    post<{ reply: unknown; questions: InboxQuestion[]; replayed: boolean }>(
      `/api/inbox/messages/${encodeURIComponent(messageId)}/reply`,
      input,
    ),
  resolve: (messageId: string, resolved: boolean) =>
    post<unknown>(`/api/inbox/messages/${encodeURIComponent(messageId)}/resolve`, { resolved }),
  health: () => get<InboxHealth>('/api/inbox/health'),
  restart: () => post<{ ok: true }>('/api/inbox/restart', {}),
  saveInboxTool: (hosts: Partial<Record<AgentToolHost, boolean>>) =>
    post<{ inbox_tool: SettingsModel['inbox_tool'] }>('/api/inbox/settings', { inbox_tool: hosts }),
  saveNotifications: (change: Partial<NotificationSettings>) =>
    post<{ notifications: NotificationSettings }>('/api/inbox/settings', { notifications: change }),
};

/** One store line as the event stream carries it (packages/server/inbox.ts, `eventPayload`). */
export type InboxEvent =
  | { seq: number; kind: 'project'; id: string; project: InboxProject }
  | { seq: number; kind: 'message'; id: string; message: InboxMessage }
  | { seq: number; kind: 'question'; id: string; question: InboxQuestion };

/**
 * The server's event stream: `onRecord` for every store line after the
 * cursor (the line, for the notifications), `onStatus` for restart-to-update. EventSource reconnects on its
 * own and resumes from the last event id.
 */
export function subscribeInboxEvents(
  cursor: number,
  handlers: { onRecord: (event: InboxEvent | null) => void; onStatus: (update: InboxHealth['update']) => void },
): () => void {
  const source = new EventSource(`/api/inbox/events?cursor=${cursor}`);
  source.addEventListener('record', (event) => {
    let parsed: InboxEvent | null = null;
    try {
      parsed = JSON.parse((event as MessageEvent<string>).data) as InboxEvent;
    } catch {
      // A malformed frame still refreshes the list.
    }
    handlers.onRecord(parsed);
  });
  source.addEventListener('status', (event) => {
    try {
      handlers.onStatus((JSON.parse((event as MessageEvent<string>).data) as { update: InboxHealth['update'] }).update);
    } catch {
      // A malformed frame changes nothing.
    }
  });
  return () => source.close();
}
