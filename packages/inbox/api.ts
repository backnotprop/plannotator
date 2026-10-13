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
  InboxListRow,
  InboxListSection,
  InboxMessage,
  InboxProject,
  InboxQuestion,
  InboxSoundSettings,
  InboxThread,
} from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxAgentId, InboxAgentsModel, InboxAnnotationRecord, InboxAttachmentState, InboxNoteAgentId } from '@plannotator/core/inbox-types';

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
  /** This Inbox started on a newer version than the one before it: "What's new in X" for this run. Absent from an older Inbox. */
  updated?: string | null;
  notice: string | null;
  projects: ProjectFolder[];
  project: string | null;
  sections: InboxListSection[];
  /** Questions in every project that record a decision once sent: the sidebar's Decisions count. */
  decisions_waiting: number;
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
  /** The decisions this thread's questions recorded, for the "Settled: ..." lines. */
  decisions: InboxDecision[];
  /** The thread's list row, an archived thread's too (the window's list leaves those out). Absent from an older Inbox. */
  row?: InboxListRow | null;
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

/** One project's counts for the Decisions page's project switch. */
export interface DecisionProjectCounts {
  project_id: string;
  /** Questions that record a decision once answered and sent. */
  waiting: number;
  /** Decisions that hold (state `current`). */
  settled: number;
}

export interface DecisionsModel {
  serverSession: string;
  cursor: number;
  project_id: string;
  waiting: WaitingDecision[];
  decisions: InboxDecision[];
  /** Every project's counts, for the project switch. Absent from an older Inbox. */
  project_counts?: DecisionProjectCounts[];
}

export interface ReplyResult {
  reply: unknown;
  questions: InboxQuestion[];
  replayed: boolean;
  decisions: InboxDecision[];
  decisions_refused: { key: string; code: string; message: string }[];
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
  current: string;
  published_at: string | null;
  release_url: string;
  notes: string;
  skipped: { version: string; text: string }[];
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
  asker?: { session: string; live: boolean };
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

/** config.json `theme`: the mode and the palette for each half (ThemeConfig in @plannotator/core/config-types). */
export interface InboxThemeConfig {
  mode?: 'light' | 'dark' | 'system';
  light?: string;
  dark?: string;
}

export const inboxApi = {
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
  /** A comment on that guide's diff (the review app's line comment), new or edited; removed through `removeAnnotation`. */
  saveGuideAnnotation: (messageId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/messages/${encodeURIComponent(messageId)}/guide/annotations`, { annotation }),
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
  saveSound: (change: { enabled?: boolean; volume?: number }) => post<{ sound: InboxSoundSettings }>('/api/inbox/settings', { sound: change }),
  /** Ask to show the one-time sound dialog: `show` is true for the first page that ever asks after an update, and only that one. */
  claimSoundDialog: () => post<{ show: boolean; sound: InboxSoundSettings }>('/api/inbox/sound/dialog', {}),
  /** Plannotator's appearance, written to config.json `theme` (shared with plan review). */
  saveTheme: (theme: InboxThemeConfig) => post<{ theme: InboxThemeConfig | null }>('/api/inbox/settings', { theme }),
  saveTailscale: (on: boolean, replaceExposed = false) =>
    post<{ tailscale: TailscaleSettings }>('/api/inbox/settings', { tailscale: replaceExposed ? { on, replace_exposed: true } : { on } }),
  // Step 2: attachments (by id only), annotations, deleting.
  attachments: (threadId: string) => get<AttachmentsModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/attachments`),
  view: (attachmentId: string, version: 'current' | 'sent') =>
    get<AttachmentView>(`/api/inbox/attachments/${encodeURIComponent(attachmentId)}/view${version === 'sent' ? '?version=sent' : ''}`),
  saveAnnotation: (attachmentId: string, version: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>('/api/inbox/annotations', { attachment_id: attachmentId, version, annotation }),
  removeAnnotation: (id: string) => post<{ annotation: InboxAnnotationRecord }>(`/api/inbox/annotations/${encodeURIComponent(id)}/remove`, {}),
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
  sessions: (threadId: string, asker?: string | null) =>
    get<LiveSessionsModel>(`/api/inbox/threads/${encodeURIComponent(threadId)}/sessions${asker ? `?asker=${encodeURIComponent(asker)}` : ''}`),
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
