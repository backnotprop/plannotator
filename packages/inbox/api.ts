/**
 * The Inbox window's client for its own server (packages/server/inbox.ts).
 * Same origin only; every state-changing call carries the page's
 * `serverSession`, so a tab left open on an older Inbox gets a 409 instead of
 * writing into a store it did not read.
 */

import type {
  InboxGuideRef,
  InboxHealth,
  InboxListRow,
  InboxListSection,
  InboxMessage,
  InboxProject,
  InboxQuestion,
  InboxSoundSettings,
  InboxTextSize,
  InboxThread,
  InboxComposeProject,
  InboxDraft,
  InboxDraftStatus,
  InboxUpload,
} from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { RecipientConnection } from './deliveryLine';
import type { InboxSearchAnswer, InboxSearchFrom, InboxSearchGroupId, InboxSearchStatus } from '@plannotator/core/inbox-search';
import type {
  InboxAgentId,
  InboxAgentsModel,
  InboxAnnotationRecord,
  InboxCardColumn,
  InboxCardWire,
  InboxAttachmentState,
  InboxMessageWire,
  InboxNoteAgentId,
  InboxNotifyReach,
  InboxWindowPermission,
} from '@plannotator/core/inbox-types';

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
  /** Threads the window's list holds (not archived). Absent from an older Inbox: the folder is always drawn. */
  listed?: number;
  /** Archived threads (resolved, none come back). Absent from an older Inbox. */
  archived?: number;
}

/** The project menu's batches (POST /api/inbox/projects/:id/read and /resolve): the threads each took. */
export interface ProjectBatchAnswer<B> {
  project: ProjectFolder | null;
  batch: B;
  threads: InboxListRow[];
  replayed: boolean;
  /** The batch stopped partway: `batch` names what it changed (Undo covers those); the rest did not change. */
  error?: { code: string; message: string };
}

export interface ListModel {
  serverSession: string;
  version: string;
  cursor: number;
  update: InboxHealth['update'];
  /** This Inbox started on a newer version than the one before it: "What's new in X" for this run. Absent from an older Inbox. */
  updated?: string | null;
  /** Claude Code sessions a /reload-plugins would bring up to date: the sidebar's "Reload Claude Code N". Absent from an older Inbox. */
  restart_claude_code?: number;
  notice: string | null;
  projects: ProjectFolder[];
  project: string | null;
  sections: InboxListSection[];
}

/** GET /api/inbox/threads/archived: Settings' Archived block, newest archived first, a page at a time. */
export interface ArchivedModel {
  serverSession: string;
  cursor: number;
  project: string | null;
  /** Every project with archived threads, and how many, for the block's project filter. */
  projects: { id: string; name: string; archived: number }[];
  /** Archived threads in the filtered scope, beyond this page too. */
  total: number;
  offset: number;
  limit: number;
  threads: InboxListRow[];
}

export interface ThreadModel {
  serverSession: string;
  cursor: number;
  thread: InboxThread;
  /** The thread's list row, an archived thread's too (the window's list leaves those out). Absent from an older Inbox. */
  row?: InboxListRow | null;
}

export interface ReplyResult {
  reply: unknown;
  questions: InboxQuestion[];
  replayed: boolean;
}

export interface UpdateSwitches {
  update_check: { on: boolean; env: boolean | null };
  auto_update: { on: boolean; env: boolean | null };
}

/** GET /api/inbox/update: what the update dialogs and Settings → About read (packages/server/inbox-updates.ts). */
export interface UpdateDetails {
  update: InboxHealth['update'];
  current: string;
  updated: string | null;
  latest: { version: string; fetched_at: string; published_at: string | null } | null;
  check: { on: boolean; env: boolean | null; last_attempt_at: string | null; error: string | null };
  auto_update: { on: boolean; env: boolean | null; supported: boolean };
  summary: string;
  flags: string[];
  command: string;
  plugin_command: string | null;
  sessions: { mode: string; project: string; label: string; started_at: string }[];
  failure: { exit_code: number; log: string } | null;
  log: string;
  snoozed_until: string | null;
}

export interface WhatsNewModel {
  version: string;
  /** The version this Inbox runs (`dev` for a development build). */
  current: string;
  /**
   * The version `skipped` counts from: `current`, or, on the page of a release
   * this Inbox already runs, the one it ran before the update. Absent from an
   * older Inbox (read as `current`).
   */
  since?: string | null;
  published_at: string | null;
  release_url: string;
  notes: string;
  skipped: { version: string; text: string }[];
  /**
   * The notes' image sources (as written) saved on this computer, loaded from
   * `whatsNewImageUrl`. Absent from an older Inbox (no image is loaded).
   */
  images?: string[];
}

/** Where the What's new page loads one of the notes' saved images. */
export function whatsNewImageUrl(version: string, src: string): string {
  return `/api/inbox/whats-new/image?version=${encodeURIComponent(version)}&src=${encodeURIComponent(src)}`;
}

/** "Over your tailnet" (packages/server/inbox-tailscale.ts): the switch, the address or why not, and who may open it. */
export interface TailscaleSettings {
  on: boolean;
  /** What decides it: `flag` (this run's `--tailscale`), `env` (PLANNOTATOR_INBOX_TAILSCALE), `config` (this switch), `default`. */
  source: 'flag' | 'env' | 'config' | 'default';
  /** PLANNOTATOR_INBOX_TAILSCALE when set: the switch is locked. */
  env: boolean | null;
  url: string | null;
  error: string | null;
  owner: string | null;
  allowed: string[];
  /** Serve routes pointing at the Inbox's own port (a hand-made mapping): each exposes the whole Inbox. Absent from an older Inbox. */
  exposed?: { https_port: number | null; target: string | null }[];
}

export interface SettingsModel {
  serverSession: string;
  /** Absent from an Inbox that predates "Over your tailnet". */
  tailscale?: TailscaleSettings;
  /** This page reached the Inbox through the tailnet (the switch cannot be turned on from there). */
  via?: 'local' | 'tailnet';
  version: string;
  port: number;
  url: string;
  mcp_url: string;
  mcp_command: string[];
  home: string;
  data_dir: string;
  inbox_tool: { hosts: Record<AgentToolHost, boolean>; env: boolean | null };
  notifications: NotificationSettings;
  /** Whether a notification can reach the person now (open windows, how many may notify). Absent from an older Inbox. */
  notify_reach?: InboxNotifyReach;
  /** The question sound (config.json inboxSound). Absent from an Inbox that predates it. */
  sound?: InboxSoundSettings;
  /** Settings → About: update notices and automatic updates (`env`: the env var decides). Absent from an older Inbox. */
  updates?: UpdateSwitches;
  /** Whether this Inbox serves phones (PLANNOTATOR_INBOX_PHONES): the Phones block shows only then. */
  phones: boolean;
  /**
   * Plannotator's appearance in config.json (`theme`), the value plan review
   * reads too: null when never chosen. Absent from an Inbox that predates it.
   */
  theme?: InboxThemeConfig | null;
  /** The window's text size in px (config.json `inboxTextSize`): 12 to 15, 14 unless chosen. Absent from an older Inbox. */
  text_size?: InboxTextSize;
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

/** One live agent session of a thread's project (New message, record 5.x). */
export interface LiveSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  /** A turn runs now; null when its connection does not say. */
  busy: boolean | null;
  idle_since: string | null;
  /** It wrote in this thread. */
  wrote_thread: boolean;
  /** Its connection can put a message into a running turn (Send now). Absent from an older Inbox. */
  send_now?: boolean;
}

export interface LiveSessionsModel {
  serverSession: string;
  home: string;
  project: InboxProject;
  /** The thread's own writers first. */
  sessions: LiveSession[];
  /**
   * Asked for with `?asker=`: whether the session that asked is still there
   * (with a 60 s grace, packages/server/inbox-sessions.ts). Absent from an
   * older Inbox, which reads as live.
   */
  asker?: {
    session: string;
    live: boolean;
    /**
     * How that session is connected now (no grace): null when its connection
     * does not poll now. Absent from an older Inbox. The line under the
     * person's message reads it ("Queued", "Sending", Send now).
     */
    connection?: RecipientConnection | null;
  };
  /**
   * Asked for with `?recipients=a,b` (approval "inbox-tag-agents"): how each
   * session a reply tags is connected now (null: its connection does not poll
   * now). Absent from an older Inbox.
   */
  recipients?: Record<string, RecipientConnection | null>;
}

/** One session the person may tag with `@` (packages/server/inbox-tags.ts). */
export interface TaggableSession {
  session: string;
  host: string | null;
  /** `live`: its connection polls and wakes it; `mcp`: it reads the Inbox only. */
  kind: 'live' | 'mcp';
  name: string | null;
  project: { id: string | null; name: string; root: string | null } | null;
  started_at: string | null;
  last_at: string;
  busy: boolean | null;
  idle_since: string | null;
  /** False: a live session on an older Plannotator; update it to tag it. */
  taggable: boolean;
  owner: boolean;
  wrote_thread: boolean;
}

export interface TaggableModel {
  serverSession: string;
  owner: { host: string | null; session: string } | null;
  sessions: TaggableSession[];
}

/** A paired phone as the window lists it (adr/implementation/inbox-mobile.md, 7.36). */
export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  carriage: boolean;
}

/** An open pairing offer (7.1): the QR link and the six digits. */
export interface PairingOffer {
  offer: { code: string; expires_at: string };
  link: string;
  computer: { name: string };
  addresses: { tailnet: string | null; lan: string | null; fingerprint: string | null };
  /** The code carries an address a phone can use (a way is on and working). Absent from an older Inbox. */
  reachable?: boolean;
}

/** What reached the door while a code showed (GET /api/inbox/pairing, packages/server/inbox-devices.ts). */
export interface PairingAttempt {
  via: 'wifi' | 'tailnet' | 'local';
  result: 'wrong_code' | 'code_over_wifi' | 'old_code' | 'expired' | 'redeemed';
  at: string;
  tries_left?: number;
  device?: string;
}

/** The last pairing offer as the window reads it: never its secret or code. */
export interface PairingOfferView {
  expires_at: string;
  state: 'open' | 'expired' | 'closed' | 'redeemed';
  tries_left: number;
  attempts: PairingAttempt[];
}

/** Step 1 of Pair a phone: what this computer can tell about each way (packages/server/inbox-pairing-checks.ts). Advisory only. */
export interface PairingChecks {
  wifi: {
    address: string | null;
    network: string | null;
    openssl: boolean;
    certificate: boolean;
    bonjour: boolean;
    firewall: 'off' | 'on' | 'block_all' | 'unknown';
  };
  tailscale: {
    /** `cli_missing`: no `tailscale` command on PATH; `no_answer`: it did not answer in time. */
    state: 'running' | 'stopped' | 'signed_out' | 'needs_approval' | 'starting' | 'cli_missing' | 'no_answer' | 'unknown';
    login: string | null;
    https_certs: boolean | null;
    port_free: boolean | null;
    error: string | null;
  };
}

/** "Reach from my tailnet": the switch, the address while it works, and why not when it does not. */
export interface TailnetState {
  on: boolean;
  address: string | null;
  error: string | null;
}

/** "Reach from this Wi-Fi": the switch, the address and the certificate's SHA-256 while it works, whether phones can find it by Bonjour, and why not when it does not. */
export interface LanState {
  on: boolean;
  address: string | null;
  fingerprint: string | null;
  bonjour: boolean;
  error: string | null;
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

/**
 * GET /api/inbox/cards: the Board (approval "inbox-board"). `dropped_unseen`
 * counts an agent's drops the person has not looked at; `threads` and
 * `projects` (step 2) name what the cards link. Both absent from an Inbox
 * before step 2.
 */
export interface CardsModel {
  serverSession: string;
  cursor: number;
  cards: InboxCardWire[];
  dropped_unseen?: number;
  threads?: Record<string, InboxListRow>;
  projects?: Record<string, { id: string; name: string; root: string }>;
}

/** The person's moves on one card (`POST /api/inbox/cards/:id`). */
export type CardMove = { op: 'move'; column: InboxCardColumn; reason?: string } | { op: 'icebox' } | { op: 'drop'; reason?: string } | { op: 'restore' };

/** config.json `theme`: the mode and the palette for each half (ThemeConfig in @plannotator/core/config-types). */
export interface InboxThemeConfig {
  mode?: 'light' | 'dark' | 'system';
  light?: string;
  dark?: string;
}

/** GET /api/inbox/search's answer (the wire is @plannotator/core/inbox-search). */
export type SearchModel = InboxSearchAnswer & { serverSession: string; recent_searches?: string[] };

export interface SearchRequest {
  q: string;
  project?: string | null;
  status?: InboxSearchStatus | null;
  from?: InboxSearchFrom | null;
  group?: InboxSearchGroupId | null;
  offset?: number;
  limit?: number;
  /** The project open in the list: a tie boost, never a filter. */
  current?: string | null;
}

/** GET /api/inbox/sessions: every live session, grouped by project (compose). */
export interface ComposeSessionsModel {
  serverSession: string;
  home: string;
  projects: InboxComposeProject[];
  /** Asked for with `?session=`: whether that session is still there (with the asker grace). */
  session?: { session: string; live: boolean };
}

/** A draft as the Drafts page lists it, with its chip. */
export type DraftView = InboxDraft & { status: InboxDraftStatus };

/** What compose sends: a new thread to one live session. */
export interface StartThreadInput {
  to: { host: string; session: string };
  body: string;
  idempotency_key: string;
  uploads?: string[];
  draft_id?: string;
  /** The thread's name (its chip): typed by the person (an agent never replaces it), or compose's suggestion with `thread_name_auto`. */
  thread_name?: string;
  /** `thread_name` is compose's suggestion the person left as it was: dropped when it cannot be used, and the agent may rename it. */
  thread_name_auto?: true;
}

/**
 * Upload one file (compose): the raw bytes, streamed by the browser, with
 * progress. XHR because fetch reports no upload progress. `serverSession`
 * rides the query (the body is the file).
 */
export function uploadFile(
  file: File,
  options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<InboxUpload> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ name: file.name });
    if (pageSession) query.set('serverSession', pageSession);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/inbox/uploads?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // Not JSON: the status says it.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.upload) resolve(body.upload as InboxUpload);
      else
        reject(
          new InboxApiError(
            xhr.status,
            typeof body.code === 'string' ? body.code : 'error',
            typeof body.error === 'string' ? body.error : xhr.status === 413 ? 'Not attached: the file is too large.' : 'Not attached: the upload failed.',
          ),
        );
    };
    xhr.onerror = () => reject(new InboxApiError(0, 'network', 'Not attached: the upload failed.'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Search (read only). `signal` aborts a request a newer query replaced. */
export async function searchInbox(request: SearchRequest, signal?: AbortSignal): Promise<SearchModel> {
  const query = new URLSearchParams({ q: request.q });
  if (request.project) query.set('project', request.project);
  if (request.status) query.set('status', request.status);
  if (request.from) query.set('from', request.from);
  if (request.group) query.set('group', request.group);
  if (request.offset) query.set('offset', String(request.offset));
  if (request.limit) query.set('limit', String(request.limit));
  if (request.current) query.set('current', request.current);
  return readJson<SearchModel>(await fetch(`/api/inbox/search?${query}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal }));
}

/** Remember a search the person opened a result from (the last 6), or forget them all. */
export function saveRecentSearch(input: { q: string } | { clear: true }): Promise<{ recent_searches: string[] }> {
  return post<{ recent_searches: string[] }>('/api/inbox/search/recent', input);
}

export const inboxApi = {
  /** The global skills the composers' `/` and `$` picker lists (raw entries; ui's catalog layer normalizes them). */
  skills: () => get<{ skills?: unknown }>('/api/inbox/skills'),
  /** One human-only skill's SKILL.md, read when the person sends a message that references it. */
  skillContent: (name: string) => get<{ skill?: unknown }>(`/api/inbox/skills/content?name=${encodeURIComponent(name)}`),
  // Archived threads leave the window's list (Settings lists them): an older
  // window and the phone, which ask without this, still get them in Quiet.
  list: () => get<ListModel>('/api/inbox/threads?archived=exclude'),
  archived: (input: { project?: string | null; offset?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.project) query.set('project', input.project);
    if (input.offset) query.set('offset', String(input.offset));
    if (input.limit) query.set('limit', String(input.limit));
    const qs = query.toString();
    return get<ArchivedModel>(`/api/inbox/threads/archived${qs ? `?${qs}` : ''}`);
  },
  thread: (threadId: string) => get<ThreadModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}`),
  /** The Board's cards, every column (approval "inbox-board"). */
  cards: () => get<CardsModel>('/api/inbox/cards'),
  /** One of the person's moves on a card: move, icebox (pause), drop, restore. */
  moveCard: (cardId: string, move: CardMove) => post<{ card: InboxCardWire }>(`/api/inbox/cards/${encodeURIComponent(cardId)}`, move),
  /** The person looked at Dropped: an agent's drops there stop showing in "N dropped by an agent". */
  cardDropsSeen: (cardIds: readonly string[]) => post<{ cards: InboxCardWire[] }>('/api/inbox/cards/dropped/seen', { cards: cardIds }),
  settings: () => get<SettingsModel>('/api/inbox/settings'),
  /**
   * The person looked at the thread. `throughSeq`: the seq of the newest
   * message the window showed; the look stops there, so a message that landed
   * after the window read the thread stays new (an older Inbox ignores it).
   */
  seen: (threadId: string, throughSeq?: number | null) =>
    post<{ thread: InboxListRow }>(
      `/api/inbox/threads/${encodeURIComponent(threadId)}/seen`,
      typeof throughSeq === 'number' ? { through_seq: throughSeq } : {},
    ),
  /** Mark read (the thread leaves the top for Quiet, its waiting questions closed) or its Undo. */
  markRead: (threadId: string, read: boolean) =>
    post<{ thread: InboxListRow }>(`/api/inbox/threads/${encodeURIComponent(threadId)}/${read ? 'read' : 'unread'}`, {}),
  /** 👍 Looks good on the agent's latest message (the thread is marked read; sent to the agent after the Undo window), or its Undo. */
  ack: (messageId: string, on: boolean) =>
    post<{ message: InboxMessageWire; thread: InboxListRow }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/ack`, { ack: on }),
  /** The project menu's Mark all as read: Mark read on every thread waiting on the person. */
  markProjectRead: (projectId: string, batchId: string) =>
    post<ProjectBatchAnswer<{ read: string[] }>>(`/api/inbox/projects/${encodeURIComponent(projectId)}/read`, { batch_id: batchId }),
  /** Its Undo: exactly the threads the batch took. */
  unmarkProjectRead: (projectId: string, threads: readonly string[]) =>
    post<{ threads: InboxListRow[]; skipped: string[] }>(`/api/inbox/projects/${encodeURIComponent(projectId)}/unread`, { threads }),
  /** The project menu's Archive all: every listed thread resolved (one that came back is marked read instead). */
  archiveProject: (projectId: string, batchId: string) =>
    post<ProjectBatchAnswer<{ resolved: string[]; read: string[] }>>(`/api/inbox/projects/${encodeURIComponent(projectId)}/resolve`, { resolved: true, batch_id: batchId }),
  /** Its Undo: exactly the threads the batch took. */
  unarchiveProject: (projectId: string, threads: { resolved: readonly string[]; read: readonly string[] }) =>
    post<{ threads: InboxListRow[]; skipped: string[] }>(`/api/inbox/projects/${encodeURIComponent(projectId)}/resolve`, { resolved: false, threads }),
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
      /** Another live session takes the reply: the session that asked has ended. */
      to?: { host: string; session: string };
      /** Skip this message's questions the Send leaves unanswered (false: Keep open). */
      skip_unanswered?: boolean;
      /** Files pasted into the reply box (upload ids): attachments on this reply. */
      uploads?: string[];
      /** The sessions the person tagged with `@` (approval "inbox-tag-agents"): each one gets this reply too. */
      tags?: { host?: string | null; session: string; label?: string }[];
    },
  ) => post<ReplyResult>(`/api/inbox/messages/${encodeURIComponent(messageId)}/reply`, input),
  /**
   * Re-ask (approval "inbox-reask"): a note asking the session that wrote this
   * message for its open questions again, in one message. `to`: another live
   * session, because the one that asked has ended.
   */
  reask: (messageId: string, input: { idempotency_key: string; to?: { host: string; session: string } }) =>
    post<ReplyResult>(`/api/inbox/messages/${encodeURIComponent(messageId)}/reask`, input),
  resolve: (messageId: string, resolved: boolean) =>
    post<unknown>(`/api/inbox/messages/${encodeURIComponent(messageId)}/resolve`, { resolved }),
  health: () => get<InboxHealth>('/api/inbox/health'),
  /** The guided review a message carries: its record and the snapshot (validated by the server, parsed again here). */
  guide: (messageId: string) =>
    get<{ message_id: string; guide: InboxGuideRef; snapshot: unknown }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide`),
  /** The person's reviewed ticks on that guide, kept on the message. */
  saveGuideReviewed: (messageId: string, reviewed: boolean[]) =>
    post<{ message_id: string; reviewed: boolean[] }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide/reviewed`, { reviewed }),
  /** A comment on that guide's diff (the review app's line comment), new or edited; removed through `removeAnnotation`. */
  saveGuideAnnotation: (messageId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide/annotations`, { annotation }),
  /** A comment on the text of an agent's message (the words selected), new or edited; removed through `removeAnnotation`. */
  saveMessageAnnotation: (messageId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/annotations`, { annotation }),
  restart: () => post<{ ok: true }>('/api/inbox/restart', {}),
  // The update control: the dialogs' facts, Update now, Remind me tomorrow, Check now, What's new.
  updateDetails: () => get<UpdateDetails>('/api/inbox/update'),
  updateNow: () => post<{ ok: true; version: string; update: InboxHealth['update'] }>('/api/inbox/update', {}),
  snoozeUpdate: () => post<{ ok: true; update: InboxHealth['update'] }>('/api/inbox/update/snooze', {}),
  checkForUpdate: () => post<UpdateDetails & { checked: { ok: boolean; error?: string } }>('/api/inbox/update/check', {}),
  whatsNew: (version: string) => get<WhatsNewModel>(`/api/inbox/whats-new?version=${encodeURIComponent(version)}`),
  saveUpdateSwitches: (change: { update_check?: boolean; auto_update?: boolean }) =>
    post<{ updates: UpdateSwitches }>('/api/inbox/settings', change),
  saveInboxTool: (hosts: Partial<Record<AgentToolHost, boolean>>) =>
    post<{ inbox_tool: SettingsModel['inbox_tool'] }>('/api/inbox/settings', { inbox_tool: hosts }),
  saveNotifications: (change: Partial<NotificationSettings>) =>
    post<{ notifications: NotificationSettings }>('/api/inbox/settings', { notifications: change }),
  /**
   * This window's notification permission for its own origin (notify.ts); an
   * older Inbox answers 404. Sent without the page's serverSession on purpose:
   * it changes nothing the person decided, and it must reach an Inbox that
   * restarted under this tab (whose serverSession is new) so the count of
   * windows that may notify is right again.
   */
  reportWindow: async (report: { window: string; permission: Exclude<InboxWindowPermission, 'unknown'>; origin: string }) =>
    readJson<{ notify_reach: InboxNotifyReach }>(
      await fetch('/api/inbox/window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(report),
      }),
    ),
  saveSound: (change: { enabled?: boolean; volume?: number }) => post<{ sound: InboxSoundSettings }>('/api/inbox/settings', { sound: change }),
  /** Ask to show the one-time sound dialog: `show` is true for the first page that ever asks after an update, and only that one. */
  claimSoundDialog: () => post<{ show: boolean; sound: InboxSoundSettings }>('/api/inbox/sound/dialog', {}),
  /** Plannotator's appearance, written to config.json `theme` (shared with plan review). */
  saveTheme: (theme: InboxThemeConfig) => post<{ theme: InboxThemeConfig | null }>('/api/inbox/settings', { theme }),
  /** The window's text size, written to config.json `inboxTextSize`. */
  saveTextSize: (textSize: InboxTextSize) => post<{ text_size: InboxTextSize }>('/api/inbox/settings', { text_size: textSize }),
  saveTailscale: (on: boolean, replaceExposed = false) =>
    post<{ tailscale: TailscaleSettings }>('/api/inbox/settings', { tailscale: replaceExposed ? { on, replace_exposed: true } : { on } }),
  // Step 2: attachments (by id only), annotations, deleting.
  attachments: (threadId: string) => get<AttachmentsModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/attachments`),
  view: (attachmentId: string, version: 'current' | 'sent') =>
    get<AttachmentView>(`/api/inbox/attachments/${encodeURIComponent(attachmentId)}/view${version === 'sent' ? '?version=sent' : ''}`),
  /** A page an attached HTML page links to (not attached itself), by a path relative to that page's folder: read-only. */
  linkedPage: (attachmentId: string, path: string) =>
    get<LinkedPageView>(`/api/inbox/attachments/${encodeURIComponent(attachmentId)}/linked-page?path=${encodeURIComponent(path)}`),
  saveAnnotation: (attachmentId: string, version: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>('/api/inbox/annotations', { attachment_id: attachmentId, version, annotation }),
  removeAnnotation: (id: string) => post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/annotations/${encodeURIComponent(id)}/remove`, {}),
  /** "Open in": the file as it is now, in a catalog app or the default app, by the attachment's id (on this computer only). */
  openIn: (attachmentId: string, appId: string) =>
    post<{ ok: boolean; error?: string }>('/api/inbox/open-in', { attachment_id: attachmentId, app_id: appId }),
  /** Keep a marked-up image (a comment drawn on an image attachment): its path rides the comment's `images`. */
  uploadMarkup: async (image: Blob) =>
    readJson<{ path: string; name: string; url: string }>(
      await fetch(`/api/inbox/markups${pageSession ? `?serverSession=${encodeURIComponent(pageSession)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': image.type || 'image/png', Accept: 'application/json' },
        body: image,
      }),
    ),
  deleteThread: (threadId: string) => post<{ store: SettingsModel['store'] }>(`/api/inbox/threads/${encodeURIComponent(threadId)}/delete`, {}),
  // Step 8: New message to a live session of the thread's project.
  // Compose: every live session, a new thread, Send to another session, and drafts.
  composeSessions: (session?: string | null) =>
    get<ComposeSessionsModel>(`/api/inbox/sessions${session ? `?session=${encodeURIComponent(session)}` : ''}`),
  startThread: (input: StartThreadInput) =>
    post<{ thread_id: string; message: InboxMessage; project?: { id: string; name: string; root: string }; replayed: boolean }>('/api/inbox/messages', { ...input }),
  readdress: (messageId: string, to: { host: string; session: string }) =>
    post<{ message: InboxMessage; row: InboxListRow | null }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/to`, { to }),
  drafts: () => get<{ serverSession: string; drafts: DraftView[] }>('/api/inbox/drafts'),
  saveDraft: (id: string, input: { body: string; to: InboxDraft['to']; project: InboxDraft['project']; files: string[]; base: string | null; thread_name?: string }) =>
    post<{ draft: DraftView }>(`/api/inbox/drafts/${encodeURIComponent(id)}`, { ...input }),
  deleteDraft: (id: string) => post<{ ok: true; deleted: boolean }>(`/api/inbox/drafts/${encodeURIComponent(id)}/delete`, {}),
  sessions: (threadId: string, asker?: string | null, recipients: readonly string[] = []) => {
    const query = [
      ...(asker ? [`asker=${encodeURIComponent(asker)}`] : []),
      ...(recipients.length > 0 ? [`recipients=${recipients.map(encodeURIComponent).join(',')}`] : []),
    ].join('&');
    return get<LiveSessionsModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/sessions${query ? `?${query}` : ''}`);
  },
  /** Who the person can tag with `@` in this thread (approval "inbox-tag-agents"). */
  taggable: (threadId: string) => get<TaggableModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/taggable`),
  /**
   * Send now: deliver the person's reply or message at once, into the running turn when one runs.
   * `session`: one tagged session's own line (absent: the session the reply goes to).
   */
  sendNow: (messageId: string, session?: string | null) =>
    post<{ message: InboxMessage }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/send-now`, session ? { session } : {}),
  newMessage: (threadId: string, input: { session: string; body: string; idempotency_key: string }) =>
    post<{ message: InboxMessage; replayed: boolean }>(`/api/inbox/threads/${encodeURIComponent(threadId)}/message`, input),
  // Phones: pairing, the paired devices, the tailnet and Wi-Fi switches (packages/server/inbox-devices.ts).
  pairPhone: () => post<PairingOffer>('/api/inbox/pairing', {}),
  pairingOffer: () => get<{ offer: PairingOfferView | null }>('/api/inbox/pairing'),
  /** `fresh`: skip the answer the Inbox keeps a few seconds (Check again, after a switch). */
  pairingChecks: (fresh = false) => get<{ checks: PairingChecks; lan: LanState; tailnet: TailnetState }>(`/api/inbox/pairing/checks${fresh ? '?fresh=1' : ''}`),
  devices: () => get<{ devices: PairedDevice[] }>('/api/inbox/devices'),
  removeDevice: (id: string) => post<{ device: PairedDevice }>(`/api/inbox/devices/${encodeURIComponent(id)}/revoke`, {}),
  tailnet: () => get<{ tailnet: TailnetState }>('/api/inbox/tailnet'),
  setTailnet: (on: boolean) => post<{ tailnet: TailnetState }>('/api/inbox/tailnet', { on }),
  lan: () => get<{ lan: LanState }>('/api/inbox/lan'),
  setLan: (on: boolean) => post<{ lan: LanState }>('/api/inbox/lan', { on }),
  /** Settings → Agents and the agent-note dialog (packages/server/inbox-agents.ts, inbox-agent-notes.ts). */
  agents: () => get<InboxAgentsModel>('/api/inbox/agents'),
  saveAgent: (agent: InboxAgentId, change: { reach?: boolean; reminder?: boolean; note?: boolean }) =>
    post<InboxAgentsModel>('/api/inbox/agents', { agent, ...change }),
  /** The note dialog's answer: `add` the ticked agents; `asked` the agents it showed (each asked once); `seen` its band showed the last run's news. */
  answerNotes: (add: InboxNoteAgentId[], asked: InboxNoteAgentId[], seen: boolean) =>
    post<InboxAgentsModel & { results: InboxNoteResult[] }>('/api/inbox/agents/notes', { add, asked, seen }),
  agentsSeen: () => post<InboxAgentsModel>('/api/inbox/agents/seen', {}),
  deleteProject: (projectId: string) => post<{ store: SettingsModel['store'] }>(`/api/inbox/projects/${encodeURIComponent(projectId)}/delete`, {}),
};

/** One note the dialog asked to add: written, or why not. */
export type InboxNoteResult = { ok: true; agent: InboxNoteAgentId; action: string; path: string } | { ok: false; agent: InboxNoteAgentId; reason: string; path: string | null };

/** One store line as the event stream carries it (packages/server/inbox.ts, `eventPayload`). */
export type InboxEvent =
  | { seq: number; kind: 'project'; id: string; project: InboxProject }
  /** `first`: the message's first line, not a later rewrite of it (a look, an archive, an Unarchive). Absent from an older Inbox. */
  | { seq: number; kind: 'message'; id: string; first?: boolean; message: InboxMessage }
  | { seq: number; kind: 'question'; id: string; question: InboxQuestion }
  | { seq: number; kind: 'annotation'; id: string; annotation: InboxAnnotationRecord }
  /** A Board card (approval "inbox-board"); absent from an older Inbox. */
  | { seq: number; kind: 'card'; id: string; card: InboxCardWire };

/** A thread's attachments as they are now, and the person's annotations waiting for a Send. */
export interface AttachmentsModel {
  serverSession: string;
  attachments: InboxAttachmentState[];
  /** The images the messages show, captured as files (additive; absent from an older Inbox). */
  inline_images?: InboxAttachmentState[];
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

/** A page an attached HTML page links to, as `/linked-page` answers it. */
export interface LinkedPageView {
  serverSession: string;
  /** Its realpath. */
  path: string;
  name: string;
  /** The page with a `<base href>` at its own folder's asset route. */
  html: string;
  /** Its asset-route URL, for Open in new tab. */
  url: string | null;
}

/**
 * The server's event stream: `onRecord` for every store line after the
 * cursor (the line, for the notifications), `onStatus` for restart-to-update. EventSource reconnects on its
 * own and resumes from the last event id.
 */
export function subscribeInboxEvents(
  cursor: number,
  handlers: {
    onRecord: (event: InboxEvent | null) => void;
    /**
     * `updated` is undefined from an Inbox older than the field (the "What's new in X" link stays as the list said);
     * `restartClaudeCode` too (the sidebar's "Reload Claude Code N" stays as the list said).
     */
    onStatus: (update: InboxHealth['update'], updated?: string | null, restartClaudeCode?: number) => void;
    /** Whether a notification can reach the person now (inbox-windows.ts); never called by an older Inbox. */
    onReach?: (reach: InboxNotifyReach) => void;
    /**
     * A row's delivery may have moved with the live sessions (a turn started or
     * ended, a session went away): no store line, so the list is read again.
     * Never called by an older Inbox.
     */
    onDeliveries?: () => void;
    /**
     * The stream (re)connected: the server's `hello`. A reconnect carries the
     * URL it was first opened with, so its `permission=` may be stale (a grant
     * since, a restarted Inbox that forgot the window): report again here.
     */
    onConnect?: () => void;
  },
  /** This window, so the server counts it (and what its browser allows) while the stream is open. */
  win?: { id: string; permission: InboxWindowPermission; origin: string },
): () => void {
  const query = new URLSearchParams({ cursor: String(cursor) });
  if (win) {
    query.set('window', win.id);
    query.set('permission', win.permission);
    query.set('origin', win.origin);
  }
  const source = new EventSource(`/api/inbox/events?${query}`);
  source.addEventListener('hello', () => handlers.onConnect?.());
  source.addEventListener('reach', (event) => {
    try {
      handlers.onReach?.(JSON.parse((event as MessageEvent<string>).data) as InboxNotifyReach);
    } catch {
      // A malformed frame changes nothing.
    }
  });
  source.addEventListener('deliveries', () => handlers.onDeliveries?.());
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
      const data = JSON.parse((event as MessageEvent<string>).data) as { update: InboxHealth['update']; updated?: string | null; restart_claude_code?: unknown };
      handlers.onStatus(
        data.update,
        'updated' in data ? (data.updated ?? null) : undefined,
        typeof data.restart_claude_code === 'number' ? data.restart_claude_code : undefined,
      );
    } catch {
      // A malformed frame changes nothing.
    }
  });
  return () => source.close();
}
