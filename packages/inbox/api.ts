/**
 * The Inbox window's client for its own server (packages/server/inbox.ts).
 * Same origin only; every state-changing call carries the page's
 * `serverSession`, so a tab left open on an older Inbox gets a 409 instead of
 * writing into a store it did not read.
 */

import type {
  InboxDecision,
  InboxDecisionAgent,
  InboxDecisionDraft,
  InboxGuideRef,
  InboxHealth,
  InboxListSection,
  InboxMessage,
  InboxProject,
  InboxQuestion,
  InboxThread,
} from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';

export type AgentToolHost = 'claude-code' | 'pi' | 'opencode';

/** The browser notifications as the Inbox keeps them (config.json, so they survive a port change). */
export interface NotificationSettings {
  enabled: boolean;
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
  /** Questions in every project that record a decision once sent: the sidebar's Decisions count. */
  decisions_waiting: number;
}

export interface ThreadModel {
  serverSession: string;
  cursor: number;
  thread: InboxThread;
  /** The decisions this thread's questions recorded, for the "Settled: ..." lines. */
  decisions: InboxDecision[];
}

/** A question that records a decision once answered and sent (the Decisions page's Waiting group). */
export interface WaitingDecision {
  question_id: string;
  message_id: string;
  thread_id: string;
  project_id: string;
  prompt: string;
  agent: InboxDecisionAgent | null;
  asked_at: string;
}

export interface DecisionsModel {
  serverSession: string;
  cursor: number;
  project_id: string;
  waiting: WaitingDecision[];
  decisions: InboxDecision[];
}

export interface ReplyResult {
  reply: unknown;
  questions: InboxQuestion[];
  replayed: boolean;
  decisions: InboxDecision[];
  decisions_refused: { key: string; code: string; message: string }[];
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
  reply: (
    messageId: string,
    input: {
      idempotency_key: string;
      words: string;
      questions: { key: string; revision: number }[];
      feedback?: string;
      annotation_ids?: string[];
    },
  ) => post<ReplyResult>(`/api/inbox/messages/${encodeURIComponent(messageId)}/reply`, input),
  /** The card's switch and its words on one question: `recording`, and `draft` on Done. */
  setDecision: (messageId: string, key: string, input: { recording?: boolean; draft?: InboxDecisionDraft | null }) =>
    post<{ question: InboxQuestion }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/decision`, { key, ...input }),
  decisions: (projectId: string) => get<DecisionsModel>(`/api/inbox/decisions?project=${encodeURIComponent(projectId)}`),
  retireDecision: (id: string, version: number) =>
    post<{ decision: InboxDecision }>(`/api/inbox/decisions/${encodeURIComponent(id)}/retire`, { version }),
  replaceDecision: (id: string, input: { version: number; text: string; reason: string }) =>
    post<{ decision: InboxDecision; replaced: InboxDecision }>(`/api/inbox/decisions/${encodeURIComponent(id)}/replace`, input),
  resolve: (messageId: string, resolved: boolean) =>
    post<unknown>(`/api/inbox/messages/${encodeURIComponent(messageId)}/resolve`, { resolved }),
  health: () => get<InboxHealth>('/api/inbox/health'),
  /** The guided review a message carries: its record and the snapshot (validated by the server, parsed again here). */
  guide: (messageId: string) =>
    get<{ message_id: string; guide: InboxGuideRef; snapshot: unknown }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide`),
  /** The person's reviewed ticks on that guide, kept on the message. */
  saveGuideReviewed: (messageId: string, reviewed: boolean[]) =>
    post<{ message_id: string; reviewed: boolean[] }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide/reviewed`, { reviewed }),
  restart: () => post<{ ok: true }>('/api/inbox/restart', {}),
  saveInboxTool: (hosts: Partial<Record<AgentToolHost, boolean>>) =>
    post<{ inbox_tool: SettingsModel['inbox_tool'] }>('/api/inbox/settings', { inbox_tool: hosts }),
  saveNotifications: (change: Partial<NotificationSettings>) =>
    post<{ notifications: NotificationSettings }>('/api/inbox/settings', { notifications: change }),
  // Step 2: attachments (by id only), annotations, deleting.
  attachments: (threadId: string) => get<AttachmentsModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/attachments`),
  view: (attachmentId: string, version: 'current' | 'sent') =>
    get<AttachmentView>(`/api/inbox/attachments/${encodeURIComponent(attachmentId)}/view${version === 'sent' ? '?version=sent' : ''}`),
  saveAnnotation: (attachmentId: string, version: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>('/api/inbox/annotations', { attachment_id: attachmentId, version, annotation }),
  removeAnnotation: (id: string) => post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/annotations/${encodeURIComponent(id)}/remove`, {}),
  deleteThread: (threadId: string) => post<{ store: SettingsModel['store'] }>(`/api/inbox/threads/${encodeURIComponent(threadId)}/delete`, {}),
  deleteProject: (projectId: string) => post<{ store: SettingsModel['store'] }>(`/api/inbox/projects/${encodeURIComponent(projectId)}/delete`, {}),
};

/** One store line as the event stream carries it (packages/server/inbox.ts, `eventPayload`). */
export type InboxEvent =
  | { seq: number; kind: 'project'; id: string; project: InboxProject }
  | { seq: number; kind: 'message'; id: string; message: InboxMessage }
  | { seq: number; kind: 'question'; id: string; question: InboxQuestion }
  | { seq: number; kind: 'annotation'; id: string; annotation: InboxAnnotationRecord };

/** A thread's attachments as they are now, and the person's annotations waiting for a Send. */
export interface AttachmentsModel {
  serverSession: string;
  attachments: InboxAttachmentState[];
  annotations: InboxAnnotationRecord[];
}

/** One version of a file: its text, and for HTML the page as annotate serves it. */
export interface AttachmentView {
  serverSession: string;
  attachment: InboxAttachmentState;
  /** "current" or the sent version's sha256: the key annotations are stored under. */
  version: string;
  text: string;
  html: string | null;
}

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
