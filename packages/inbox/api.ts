/**
 * The Inbox window's client for its own server (packages/server/inbox.ts).
 * Same origin only; every state-changing call carries the page's
 * `serverSession`, so a tab left open on an older Inbox gets a 409 instead of
 * writing into a store it did not read.
 */

import { readHello, type RestartHello } from './sessionAdopt';
import type { InboxSidebarLayout } from '@plannotator/core/inbox-sidebar';
import type { DecisionDataSummary, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { problemOf } from '@plannotator/core/problem';
import type { ProblemFacts } from '@plannotator/core/problem-report';
import type { FaviconStyle } from '@plannotator/core/favicon';
import type { InboxShowMeTarget } from '@plannotator/core/inbox-review';
import type { SystemSetup, SystemSetupAnswer, SystemSetupInput } from '@plannotator/core/inbox-system-setup';
import type { SystemDrawingAnswer, SystemProjectsAnswer, SystemPullsAnswer } from '@plannotator/core/inbox-system';
import type { SystemModel } from '@plannotator/system';
import type { ShapeDrawnView, ShapeNote, ShapeRecord, ShapeRef, ShapeVersion } from '@plannotator/core/shape';
import type { InboxArtifactPin, InboxArtifactsPage, InboxArtifactType } from '@plannotator/core/inbox-artifact-pins';
import type { InboxAgentFaceChange } from '@plannotator/core/inbox-types';
import { isActionRecord, questionsOnly, splitThreadActions } from './actions';
import { createListReader, type ListReadAnswer } from './listRead';
import { inboxUrl, isContested, localRoute, machineOf, rememberLocal, rememberMachine, selfMachineId, setSelfMachine } from './inboxUrl';
import { learnProjects } from './projectPictures';
import { learnDefaultRefHost } from './defaultRefHost';
import type { ReplyViewing } from './replyViewing';
import type {
  InboxCardMark,
  InboxInitiative,
  InboxDecisionsModel,
  InboxGuideRef,
  InboxHealth,
  InboxListRow,
  InboxListSection,
  InboxMessage,
  InboxProject,
  InboxQuestion,
  InboxSoundSettings,
  InboxTextSize,
  InboxReaction,
  InboxReactionChange,
  InboxRowsOption,
  InboxTourChange,
  InboxTourState,
  InboxThread,
  InboxComposeProject,
  InboxComposeLaunch,
  InboxLaunchAgent,
  InboxLaunchTrust,
  InboxRun,
  InboxDraft,
  InboxDraftPasted,
  InboxReplyDraft,
  InboxReplyDraftRow,
  InboxDraftStatus,
  InboxUpload,
  InboxPromptsChange,
  InboxPromptsSettings,
  InboxVoiceEngine,
  InboxVoiceFailure,
  InboxVoiceKeyState,
  InboxVoiceSettings,
  InboxVoiceStatus,
} from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { inboxSectionsAsOf } from '@plannotator/core/inbox-snooze';
import { NO_FILE_OPS, type ReplyDraftFileOps } from '@plannotator/core/inbox-reply-draft';
import { FEEDBACK_UNAVAILABLE } from '@plannotator/core/product-feedback';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { learnDebugLog, resumeDebugLog } from './debugLog';
import type { RecipientConnection } from './deliveryLine';
import { parseRestartAgents } from './restartAgents';
import type { PatchBlobIds } from '@plannotator/core/diff-files';
import type { InboxFileContents, InboxPullDetailsAnswer, InboxPullDiffAnswer, InboxPullDiffScope, InboxPullRiskAnswer, InboxPullRiskModels, InboxPullsAnswer, InboxReviewChanges, InboxReviewChangesAnswer, InboxReviewLinkAnswer, InboxReviewsAnswer, InboxRestartAgents, InboxTidyPlan, InboxTidyRun, InboxActivityModel } from '@plannotator/core/inbox-types';
import type { InboxSearchAnswer, InboxSearchFrom, InboxSearchGroupId, InboxSearchSort, InboxSearchStatus } from '@plannotator/core/inbox-search';
import type {
  InboxAgentId,
  InboxAccountsRead,
  InboxAccountSwitch,
  InboxAccountSwitchTarget,
  InboxMachineAccountsRead,
  InboxAgentsModel,
  InboxCodexAccount,
  InboxAnnotationRecord,
  InboxCardColumn,
  InboxCardHistoryEntry,
  InboxCardRef,
  InboxCardWire,
  InboxStepsWire,
  InboxThreadPullsAnswer,
  InboxThreadPullWire,
  InboxAttachmentState,
  InboxMessageWire,
  InboxNoteAgentId,
  InboxNoteAutoAdd,
  InboxNotifyReach,
  InboxProjectRepo,
  InboxWindowPermission,
} from '@plannotator/core/inbox-types';

import { browserSharedEventsEnv, sharedInboxEventsSupported, subscribeOwnInboxEvents, subscribeSharedInboxEvents } from './sharedEvents';
import { newUuid } from './uuid';

/**
 * A dialog of the line of one-time dialogs, as the Inbox names it (the queue: packages/shared/inbox/reveals.ts, server
 * side): the update-day dialogs, then the offers. A registered dialog (Bro mode, List view) adds its id here.
 */
export type InboxRevealId = 'theme_chooser' | 'code_review' | 'sound' | 'list_intro' | 'voice' | 'tab_icon' | 'snooze' | 'bro' | 'grill_me_tip' | 'board' | 'steps' | 'star' | 'list_view';
/** What the line claims (`POST /api/inbox/reveal`): every offer, and the tab icon, the one update-day dialog claimed through the line. */
export type InboxRevealOfferId = Exclude<InboxRevealId, 'sound' | 'list_intro' | 'voice'>;
/** What a page claims through `POST /api/inbox/reveal`: Snooze, an offer, the agent note, the Launch tip or the Sidebar tip (both outside the line). */
export type InboxRevealClaimId = InboxRevealOfferId | 'agent_note' | 'launch_tip' | 'sidebar_tip';

/**
 * This page load's id, sent with every read and write (`X-Plannotator-Load`): the Inbox keeps it with a one-time
 * dialog's stamp, as a record (packages/shared/inbox/reveals.ts; the page-load rule it once served ended 2026-11-09).
 */
const pageLoad = newUuid();

/** The last reply this page sent, and its length in words: voice's moment is a long reply just sent. */
let lastReply: { at: number; words: number } | null = null;
const replyListeners = new Set<(reply: { at: number; words: number }) => void>();
/** Listen for this page's replies (each one sent: when, and its words). Returns the unsubscribe. */
export function onReplySent(listener: (reply: { at: number; words: number }) => void): () => void {
  replyListeners.add(listener);
  return () => replyListeners.delete(listener);
}
/** The last reply this page sent, or null. */
export function lastReplySent(): { at: number; words: number } | null {
  return lastReply;
}
function noteReplySent(words: string): void {
  const count = words.trim() === '' ? 0 : words.trim().split(/\s+/).length;
  lastReply = { at: Date.now(), words: count };
  for (const listener of replyListeners) listener(lastReply);
}

export type AgentToolHost = 'claude-code' | 'pi' | 'opencode' | 'dsh' | 'cline';

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
  /** The machine whose project it is (`ibx_…`), in the merged view only. */
  machine?: string;
  /** The projects combined into this one: a link to one opens this project. Absent when there are none. */
  combined?: { id: string; name: string; root: string }[];
  /** When its letter mark's picture was set (Set picture…, ms). Absent when none, and from an older Inbox. */
  picture?: number;
  /**
   * Its git origin's host (null: a remote that names none, which links as github.com). Absent for a project with no
   * repo (or none resolved yet), and from an older Inbox. Read for `defaultRefHost.ts`.
   */
  repo_host?: string | null;
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

/** `GET /api/inbox/cards`: the Board. `seen_seq` (the person's last look, a store seq) is absent from an Inbox before step 2. */
export interface CardsModel {
  serverSession: string;
  cursor: number;
  cards: InboxCardWire[];
  dropped_unseen: number;
  seen_seq?: number | null;
  /** Each linked thread's list row (archived ones too), for the opened card. Absent from an older Inbox. */
  threads?: Record<string, InboxListRow | null>;
  /** While the person's checklist switch is on: each linked thread's lists with steps (approval "inbox-thread-steps"). Absent: off, or an older Inbox. */
  steps?: Record<string, InboxStepsWire[]>;
  /** The Board's initiatives, deleted ones too (approval "board-initiatives"). Absent from an older Inbox: none. */
  initiatives?: InboxInitiative[];
  /**
   * Approval "board-hashtags": per live initiative that a message tags, the latest-tagged threads no card of it
   * links (at most 4, newest first; their rows are in `threads`) and `total`, how many such threads in all.
   * Absent from an older Inbox: the preview lists no threads.
   */
  initiative_threads?: Record<string, { threads: string[]; total: number }>;
}

/** A draft's file as a save names it: an upload id, or the id with where a long paste goes back. */
export type DraftFileInput = string | { upload_id: string; pasted?: InboxDraftPasted };

/**
 * A machine as the merged list and its `machines` frames name it (linked machines,
 * packages/server/inbox-machines.ts `MachineView`): this Inbox (`self`) and each linked one.
 */
export interface MachineView {
  id: string;
  name: string;
  self: boolean;
  state: 'online' | 'connecting' | 'offline' | 'needs_update' | 'revoked';
  /** When it entered that state. */
  since: string;
  reason: string | null;
  version: string | null;
  address: string | null;
  both_ways: boolean;
  /** Writes held for it. */
  waiting: number;
  /** The cursor of its list this Inbox holds: it moves when its rows changed. Absent from an older Inbox. */
  list_cursor?: number | null;
  /** Its Inbox keeps snoozes (approval "inbox-snooze"). Absent from an older Inbox, and false for a linked one too old: nothing to snooze with on its rows (`snooze_old`). */
  snoozes?: boolean;
  /**
   * Remote launch: agents can start there (true), launch is off there (false), or its Inbox is too old to say (null;
   * null for this machine, whose own launch block says). Absent from an older Inbox.
   */
  launch?: boolean | null;
  /**
   * Its store takes a Delete on an agent message's words. Not: a Delete it refuses (422) reads "<name> needs an
   * update to delete words · Update". Absent from an older Inbox serving the window; false for a linked one too old.
   */
  message_deletions?: boolean;
  /** Its list was read and keeps no snoozes: an older Inbox, so Snooze says why instead of vanishing. */
  snooze_old?: boolean;
  /** Update on that machine, from its own state. Null: nothing to say (level, ahead, this machine, or no newer release known). */
  update?: MachineUpdateView | null;
}

/** A linked machine's update, as `machineUpdateView` (inbox-machines.ts) reads what it hears from there. */
export interface MachineUpdateView {
  phase: 'behind' | 'updating' | 'ready' | 'failed' | 'restarting' | 'not_back' | 'updated';
  target: string | null;
  from: string | null;
  can_update: boolean;
  self_update: boolean;
  /** The person asked an agent there to update it (an older machine): its thread (null while held) and the agent's name. */
  asked?: { thread: string | null; agent: string; at: string };
}

/** What the dialog reads from that machine (`GET /api/inbox/machines/:id/update`). The log comes as `~/…`, so no username crosses. */
export interface MachineUpdateDetails {
  too_old?: boolean;
  current: string | null;
  update?: { state: string; version: string; action: 'script' | 'copy' } | null;
  platform?: 'darwin' | 'linux' | 'win32';
  command?: string;
  log?: string;
  open_reviews?: number;
  failure?: { exit_code: number; tls?: 'untrusted' | 'revoked'; release_first?: true; prepare?: string; unchanged?: true } | null;
}

/** A write held for another machine (`GET /api/inbox/outbox`, the `outbox` frame). */
export interface OutboxView {
  key: string;
  machine: string;
  /** The door route, as `messages/msg_…/reply`. */
  route: string;
  /** `cancelled`: taken back before it ever left (Cancel on a held launch); never sent. */
  state: 'queued' | 'sending' | 'delivered' | 'refused' | 'parked' | 'dropped' | 'cancelled';
  queued_at: string;
  settled_at: string | null;
  status: number | null;
  answer: unknown;
  notice: { kind: 'refused' | 'not_delivered' | 'may_have_been_delivered'; at: string } | null;
  dismissed: boolean;
  /** A held reply's or message's words. Absent from an older Inbox. */
  words?: string | null;
  /** The thread it is about, as this window named it when it pressed Send. Absent from an older Inbox. */
  thread?: string | null;
  /** The machine's name, kept once its link went (an Unlink here or on that machine). */
  machine_name?: string | null;
}

/** `POST /api/inbox/machines/offer`: this machine's one-time link code for another. */
export interface MachineOffer {
  link: string;
  code: string;
  expires_at: string;
  machine: { id: string; name: string };
  tailnet: string | null;
  tailnet_error: string | null;
}

export interface ListModel {
  /**
   * The merged view (`machines=1`): this Inbox's id and every machine, linked ones with their state. Absent from
   * an Inbox that cannot link; with no machine linked, `machines` holds this Inbox alone.
   */
  self?: string;
  machines?: MachineView[];
  serverSession: string;
  version: string;
  cursor: number;
  update: InboxHealth['update'];
  /** This Inbox started on a newer version than the one before it: "What's new in X" for this run. Absent from an older Inbox. */
  updated?: string | null;
  /** Claude Code sessions a /reload-plugins would bring up to date: the sidebar's "Reload Claude Code N". Absent from an older Inbox. */
  restart_claude_code?: number;
  /** Every runtime's sessions a reload brings up to date: the sidebar's "Reload agents N". Absent from an older Inbox. */
  restart_agents?: InboxRestartAgents;
  /** Checking for updates has failed for hours: the sidebar's quiet "Can't check for updates". Absent from an older Inbox. */
  update_check_failing?: UpdateCheckFailing | null;
  notice: string | null;
  projects: ProjectFolder[];
  project: string | null;
  sections: InboxListSection[];
  /**
   * The threads snoozed now, soonest back first (approval "inbox-snooze"): the
   * band under Quiet. They are in no section, so no count reads them. Absent
   * from an older Inbox: the window then offers no snooze.
   */
  snoozed?: InboxListRow[];
  /**
   * The sidebar's pinned threads (approval "inbox-pinned-threads"), in pin
   * order, whatever the project filter (an archived thread stays pinned).
   * Absent from an older Inbox: the window then draws no Pinned section and
   * offers no pin.
   */
  pins?: InboxListRow[];
  /** The version of this list, named by the next read so only what changed comes back (listRead.ts). Absent from an older Inbox. */
  list_version?: string;
  /**
   * Each session's label by id (issue #2450; sessionLabels.ts): the rows' agents and a message's author. Absent from
   * an older Inbox and for a tailnet guest, which then read every session as before.
   */
  session_labels?: Record<string, string>;
  /**
   * Each machine's agents (the Agents section; agentsList.ts holds them): this Inbox's group, then each linked
   * machine's on the merged view. Absent from an older Inbox.
   */
  agents?: InboxAgentsGroup[];
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
  /** A launched thread's run line (inbox-launch.ts): null while the agent rests. Absent: not a launched thread, or launch is off. */
  run?: InboxRun | null;
  /** With `run`: the command that attaches to the launched session in a terminal, also while it rests; null before it exists. */
  attach_command?: string | null;
}

export interface ReplyResult {
  reply: unknown;
  questions: InboxQuestion[];
  replayed: boolean;
  /** To another machine: held in this Inbox's outbox until that machine's Inbox answers (the thread shows it waiting). */
  held?: OutboxView;
}

/** A held reply (`InboxHeldError`) is a Send that went into the outbox: the thread shows it as waiting, never as delivered. */
function heldReply(cause: unknown): ReplyResult {
  if (cause instanceof InboxHeldError) return { reply: null, questions: [], replayed: false, held: cause.outbox };
  throw cause;
}

export interface UpdateSwitches {
  update_check: { on: boolean; env: boolean | null };
  auto_update: { on: boolean; env: boolean | null };
}

/** Checking for updates has failed for hours with no success (packages/shared/update-check.ts releaseCheckFailing). */
export interface UpdateCheckFailing {
  since: string;
  error: string;
}

/** GET /api/inbox/update: what the update dialogs and Settings → About read (packages/server/inbox-updates.ts). */
export interface UpdateDetails {
  update: InboxHealth['update'];
  current: string;
  updated: string | null;
  latest: { version: string; fetched_at: string; published_at: string | null } | null;
  check: {
    on: boolean;
    env: boolean | null;
    last_attempt_at: string | null;
    error: string | null;
    /** Checking has failed for hours with no success. Absent from an older Inbox. */
    failing?: UpdateCheckFailing | null;
    /** When the latest attempt failed (null: it did not). Absent from an older Inbox. */
    last_failed_at?: string | null;
  };
  auto_update: { on: boolean; env: boolean | null; supported: boolean };
  summary: string;
  flags: string[];
  command: string;
  plugin_command: string | null;
  sessions: { mode: string; project: string; label: string; started_at: string }[];
  /** `tls` (exit 75 only): the download failed at TLS. Absent from an older Inbox. */
  /**
   * `release_first` (macOS, `untrusted` only): the release page before the install command.
   * `prepare` (exit 75): downloaded, but the temp folder could not hold it; the plain reason.
   */
  failure: { exit_code: number; log: string; tls?: 'untrusted' | 'revoked'; release_first?: true; prepare?: string } | null;
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
  /**
   * The `### TL;DR` at the top of the notes (taken out of `notes`): `label` is
   * New, Changed, Fixed, Removed or Off by default (another label as written,
   * "" for none). Absent from an older Inbox (read as none).
   */
  tldr?: TldrLine[];
  skipped: { version: string; text: string }[];
  /**
   * The notes' image sources (as written) saved on this computer, loaded from
   * `whatsNewImageUrl`. Absent from an older Inbox (no image is loaded).
   */
  images?: string[];
}

/** One line of a release's TL;DR. */
export interface TldrLine {
  label: string;
  text: string;
}

/** One release in What's new's releases panel (GET /api/inbox/whats-new/releases). */
export interface WhatsNewRelease {
  version: string;
  published_at: string | null;
  /** Its TL;DR (empty: none). */
  tldr: TldrLine[];
  /** Its line in the newest saved "Missed recent releases?" table, and the release whose notes carry it. */
  listed: { text: string; in: string } | null;
  /** The first sentence of its saved notes. */
  sentence: string | null;
  /** Its notes are saved on this computer. */
  saved: boolean;
}

export interface WhatsNewReleasesModel {
  /** The newest release (the Latest card); null with no rows. */
  latest: string | null;
  current: string;
  /** Newest first. */
  releases: WhatsNewRelease[];
  /** The list is being asked for now: ask again shortly. */
  refreshing: boolean;
  /** The last request for the list failed. */
  offline: boolean;
  fetched_at: string | null;
}

/** Where the What's new page loads one of the notes' saved images. */
export function whatsNewImageUrl(version: string, src: string): string {
  return inboxUrl(`/whats-new/image?version=${encodeURIComponent(version)}&src=${encodeURIComponent(src)}`);
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

/** Split (old beside new) or Unified (one column): the diff layout code review and guided reviews share. */
export type InboxDiffStyle = 'split' | 'unified';

/**
 * How diffs are drawn (config.json `diffOptions`, shared with code review), by
 * the wire's names: each null when never chosen. Whole file, Hide whitespace
 * and the fonts are code review's alone.
 */
export interface InboxDiffOptions {
  diff_style: InboxDiffStyle | null;
  overflow: 'scroll' | 'wrap' | null;
  indicators: 'bars' | 'classic' | 'none' | null;
  line_diff_type: 'word-alt' | 'word' | 'char' | 'none' | null;
  line_numbers: boolean | null;
  background: boolean | null;
  background_intensity: 'subtle' | 'normal' | 'strong' | null;
  tab_size: number | null;
}

/** Settings → General's cookie switch (SettingsModel.cookie_host). */
export interface InboxCookieHost {
  on: boolean;
  env: string | null;
  url_host: string | null;
}

export interface SettingsModel {
  serverSession: string;
  /** Absent from an Inbox that predates "Over your tailnet". */
  tailscale?: TailscaleSettings;
  /** This page reached the Inbox through the tailnet (the switch cannot be turned on from there). */
  via?: 'local' | 'tailnet';
  /** A tailnet login other than the owner's (`tailnetGuest` reads it). Absent from an older Inbox. */
  guest?: boolean;
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
  /** The one-time list options dialog waits to be claimed (POST /api/inbox/list-intro). Absent from an older Inbox. */
  list_intro?: { due: boolean };
  /** The one-time Snooze announcement waits to be claimed by this page (POST /api/inbox/snooze-intro). Absent from an older Inbox. */
  snooze_intro?: { due: boolean };
  /**
   * The line of one-time dialogs: the one this page may arm, or null; `ahead`: the offers it may also arm, each going
   * as soon as its own moment comes (List view); `setup`: the agent note may show on this load (absent from an older
   * Inbox: it may); `line`: this Inbox keeps the line (a release build), so the update-day dialogs (sound, list
   * options, voice) show only when `next` names them; `aside`: the star ask, which this page may arm beside `next` (it
   * stands outside the line's order); `launch_tip`: the Launch tip may show at the first plain New message (outside the
   * line; absent from an older Inbox: it never shows); `sidebar_tip`: the Sidebar tip may show at a calm moment beside
   * the open sidebar (outside the line; absent from an older Inbox: it never shows). The whole field is absent from an
   * older Inbox.
   */
  reveal?: { next: InboxRevealId | null; ahead?: InboxRevealId[]; setup?: boolean; line?: boolean; aside?: InboxRevealId[]; launch_tip?: boolean; sidebar_tip?: boolean; /** ms until a date can change the line, or null (reveals.ts `revealAgainAt`). */ again_in?: number | null };
  /** Voice dictation (config.json inboxVoice). Absent from an Inbox that predates it. */
  voice?: InboxVoiceSettings;
  /** Settings → About: update notices and automatic updates (`env`: the env var decides). Absent from an older Inbox. */
  updates?: UpdateSwitches;
  /** Whether this Inbox serves phones (PLANNOTATOR_INBOX_PHONES): the Phones block shows only then. */
  phones: boolean;
  /** Ask AI is on for this reader: always true now (Ask has no switch), kept for older windows. Absent for a tailnet guest and from an older Inbox. */
  ask_ai?: true;
  /** `cswap` is on this computer: the sidebar's Usage row is there before the first read. False for a tailnet guest. Absent from an older Inbox. */
  cswap?: boolean;
  /**
   * Plannotator's appearance in config.json (`theme`), the value plan review
   * reads too: null when never chosen. Absent from an Inbox that predates it.
   */
  theme?: InboxThemeConfig | null;
  /** The window's text size in px (config.json `inboxTextSize`): 12 to 15, 14 unless chosen. Absent from an older Inbox. */
  text_size?: InboxTextSize;
  /**
   * The favicon (config.json `favicon`), shared with plan review, code review and annotate: 'glass' unless chosen,
   * 'yellow' or 'totman' (shown as Face). Absent from an older Inbox.
   */
  favicon?: FaviconStyle;
  /** The reaction tray's saved emoji (config.json `inboxReactions`): up to 5, in the order saved. Absent from an older Inbox. */
  reactions?: InboxReaction[];
  /** How many times `reactions` was saved (config.json `inboxReactionsRev`): a window takes a list only when it is newer. */
  reactions_rev?: number;
  /**
   * How the list's rows look (config.json `inboxRows`): the options that are on. Null until a window first saves it
   * (this browser's old cookies are adopted then); absent from an older Inbox.
   */
  rows?: InboxRowsOption[] | null;
  /** How many times `rows` was saved (config.json `inboxRowsRev`): a window takes a look only when it is newer. */
  rows_rev?: number;
  /** The sidebar's layout (config.json `inboxSidebar`, approval "inbox-sidebar-customize"): null until first saved; absent from an older Inbox. */
  sidebar?: unknown;
  /** How many times `sidebar` was saved (config.json `inboxSidebarRev`): a window takes a layout only when it is newer. */
  sidebar_rev?: number;
  /** The name on this person's comments (config.json `displayName`): null when never set. Absent for a guest and from an older Inbox. */
  display_name?: string | null;
  /**
   * The diff layout guided reviews draw (config.json `diffOptions.diffStyle`),
   * shared with code review: null when never chosen. Absent from an older Inbox.
   */
  diff_style?: InboxDiffStyle | null;
  /** How diffs are drawn (config.json `diffOptions`, shared with code review). Absent from an older Inbox. */
  diff_options?: InboxDiffOptions;
  /** Experimental features, each off unless switched on (`env`: PLANNOTATOR_EXPERIMENTAL decides). Absent from an older Inbox. */
  experimental?: InboxExperimentalSettings;
  /** The Board (config.json `inboxBoard`): off unless the person turned it on. Absent from an Inbox before the switch (the Board is then always there). */
  board?: { on: boolean };
  /** Thread steps (config.json `inboxSteps`, approval "inbox-thread-steps"): off unless the person turned them on. Absent from an older Inbox (no steps then). */
  steps?: { on: boolean };
  /** Bro mode (config.json `inboxBro`, approval "bro-mode"): off unless the person turned it on. Absent from an older Inbox (no row then). */
  bro?: { on: boolean };
  /** Floating reply drafts (config.json `inboxFloatDrafts`, approval "inbox-reply-floaters"): off unless the person turned it on. Absent from an older Inbox (off then). */
  float_drafts?: { on: boolean };
  /** The warning before a Mark read that sets questions aside (config.json `inboxMarkReadWarning`): on unless the person turned it off. Absent from an older Inbox (no warning then). */
  mark_read_warning?: { on: boolean };
  /** Code review (config.json `inboxCodeReview`, approval "inbox-code-review-direction"): off unless the person turned it on. Absent from an older Inbox (off then). */
  code_review?: { on: boolean };
  /** Shape (Settings → Capabilities): the boards agents draw. Absent from an older Inbox. */
  shape?: { on: boolean };
  /**
   * System (config.json `inboxSystem`, approval "system-inbox"): its switch, present only while Code review is on (the
   * Settings row shows only then). Whether System shows is `systemShown()` (system/gate.ts).
   */
  system?: { on: boolean };
  /**
   * Chapter diagrams (config.json `inboxChapterDiagrams`, on unless false): its switch, present only while Code review
   * is on (the Settings row shows only then). Off: agents are not offered chapter diagrams, and one that still arrives
   * draws folded. Absent: on.
   */
  chapter_diagrams?: { on: boolean };
  /**
   * Settings → General: "Open Plannotator at plannotator.localhost" (#2184): config.json
   * `urlHost: "plannotator.localhost"`. `env` is PLANNOTATOR_URL_HOST and `url_host`
   * another config.json `urlHost`; either locks it. Absent for a tailnet guest
   * and from an older Inbox.
   */
  cookie_host?: InboxCookieHost;
  /** The onboarding tour (config.json `inboxTour`): started, finished, skipped. Absent from an Inbox that predates it. */
  tour?: InboxTourState;
  /** Settings → Prompts: the Inbox reminder and the plan, review and annotate prompts. Absent from an older Inbox. */
  prompts?: InboxPromptsSettings;
  /** Settings → Agents' "Start agents from New message" switch (`enabled`) and, while on, its launch rows. Absent from an Inbox older than 0.29, which sent it only while on. */
  launch?: InboxLaunchSettings;
  /** The store's folder (Settings → Storage's line). Its sizes are their own read: `inboxApi.storage()`. Absent from an older Inbox. */
  store_dir?: string;
  /** The sizes, from an older Inbox only (a current one leaves them out for `?store=0`). */
  store?: InboxStorageModel;
}

/** `GET /api/inbox/settings/storage`: what the store holds on disk, for Settings → Storage. A walk of every file: read it only for that panel. */
export interface InboxStorageModel {
  dir: string;
  bytes: number;
  projects: {
    id: string;
    name: string;
    root: string;
    bytes: number;
    threads: { thread_id: string; subject: string | null; bytes: number }[];
    /** The project this folder was combined into, by name. */
    combined_into?: string;
    /** The projects combined into this one, by name: deleting it leaves them. */
    combined?: string[];
  }[];
}

/** Settings → Agents: starting agents from New message (config.json `inboxLaunch`). Off, only `enabled` and a false `full_permissions`. */
export interface InboxLaunchSettings {
  /** "Start agents from New message": on unless config.json `inboxLaunch.enabled` is false (off by default on Windows). */
  enabled: boolean;
  /** Windows: launch has no support there, so Settings → Agents shows no switch (config.json only). */
  unsupported?: boolean;
  /** "Start new sessions with full permissions": Claude Code starts in bypass mode (otherwise auto mode). */
  full_permissions: boolean;
  /** Never set by the person, and on because their Claude settings (`claude`) or their shell (`shell`) run Claude in bypass mode. */
  follows?: 'claude' | 'shell' | null;
  /** A launch starts in the person's own Claude default mode (not auto). */
  own_mode?: boolean;
  /** Full permissions wanted, but Claude Code's bypass notice is not accepted on this computer: a launch starts without them. */
  needs_consent?: boolean;
  /** Full permissions wanted, but Claude Code's own settings turn bypass mode off: a launch starts without them. */
  bypass_off?: boolean;
  /** Where new scratch folders go (absolute), and as shown (`~/…`). Absent from an older Inbox. */
  scratch_dir?: string;
  scratch_dir_shown?: string;
}

/**
 * A page from a tailnet login other than the owner's: what is about this computer stays closed to it. Over the
 * tailnet an Inbox that does not say counts as a guest, so a page never offers what its server may refuse.
 */
export function tailnetGuest(settings: Pick<SettingsModel, 'via' | 'guest'> | null | undefined): boolean {
  return settings?.via === 'tailnet' && settings.guest !== false;
}

/**
 * Whether this page offers Ask AI: in every Inbox, with no switch (approval "inbox-ask-ai-flow", addendum
 * 2026-11-07), once the settings say whose page it is; never for a tailnet guest, and never in the tour.
 */
export function inboxAskOn(settings: Pick<SettingsModel, 'via' | 'guest'> | null | undefined, tourOn: boolean): boolean {
  return settings != null && !tailnetGuest(settings) && !tourOn;
}

/** Settings → Capabilities → Experimental: each feature's switch, and whether the env var decides it. */
export interface InboxExperimentalSettings {
  decision_mode: { on: boolean; env: boolean | null };
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
  /** The session's label (issue #2450): Send to another session's rows. Absent when it has none, from an older Inbox, and for a tailnet guest. */
  label?: string;
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
    /**
     * The thread's items that session's connection took and will never deliver (its wake stopped mid-delivery):
     * their line says not delivered, and they may move. Absent when none, and from an older Inbox.
     */
    stuck?: string[];
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
  /** A live session's label (issue #2450). Absent when it has none, from an older Inbox, and for a tailnet guest. */
  label?: string;
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
    /** A port the door may take (8443 to 8450) is free or already the Inbox's. */
    port_free: boolean | null;
    /** The port it would take, or (with `port_free: false`) its kept port another mapping now holds; absent from an older Inbox. */
    https_port?: number | null;
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

/** Where Post decisions puts a thread's decisions: the PR's description (default), a comment, or a short section plus the comment. */
export type DecisionsPostTo = 'description' | 'comment' | 'both';

export class InboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The request's field the refusal names (`files[1]`), when it names one. */
    readonly field: string | null = null,
    /** When a held read may be asked again (ms since the epoch), when the answer says. */
    readonly retryAt: number | null = null,
    /** `thread_name_taken`: the one open thread that has the name, when the answer names it. */
    readonly threadId: string | null = null,
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
      typeof body.field === 'string' ? body.field : null,
      typeof body.retry_at === 'number' ? body.retry_at : null,
      typeof body.thread_id === 'string' ? body.thread_id : null,
    );
  }
  return body as T;
}

/** The machine a forwarded URL goes to (`/api/inbox/m/<machine>/…`), or null for this Inbox's own route. */
function forwardedTo(path: string): string | null {
  return /^\/api\/inbox\/m\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\//.exec(path)?.[1] ?? null;
}

/**
 * Every id in another machine's answer belongs to that machine (ids are ULIDs or UUIDs, one record each): an
 * `id` or `…_id` field long enough to be one. Remembered, so the routes of its messages, files and comments go
 * there too (inboxUrl.ts).
 */
const ROUTED_ID_KEYS = new Set(['id', 'thread_id', 'message_id', 'attachment_id', 'annotation_id', 'project_id', 'upload_id', 'markup_id']);

export function idsIn(value: unknown, out: Set<string> = new Set(), depth = 0, onlyLocal = false): Set<string> {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) idsIn(item, out, depth + 1, onlyLocal);
    return out;
  }
  // In this Inbox's own answer, a record another machine sent (a merged row or project, an outbox entry) is that
  // machine's: its ids are not this Inbox's.
  const owner = (value as { machine?: unknown }).machine;
  if (onlyLocal && typeof owner === 'string' && owner !== selfMachineId()) return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      if (ROUTED_ID_KEYS.has(key) && /^[A-Za-z0-9_-]{16,80}$/.test(item) && !item.startsWith('ibx_')) out.add(item);
    } else idsIn(item, out, depth + 1, onlyLocal);
  }
  return out;
}

/** The ids of this Inbox's own records in one of its answers: local for good (inboxUrl.ts `rememberLocal`). */
export function localIdsIn(value: unknown): Set<string> {
  return idsIn(value, new Set(), 0, true);
}

/** Two linked machines claim the thread, message, file or project a path names: it goes to neither (inboxUrl.ts). */
export const CONFLICT_TEXT = 'Two linked machines both claim this thread, so it opens on neither. Unlink the one that should not have it.';
function refuseContested(path: string): void {
  const named = /^\/api\/inbox\/(?:threads|messages|attachments|projects)\/([^/?]+)/.exec(path)?.[1];
  if (named && isContested(decodeURIComponent(named))) throw new InboxApiError(409, 'machine_conflict', CONFLICT_TEXT);
}


/**
 * The server refused a forward because the id is this Inbox's (`id_is_local`): it is local from now on, and the read
 * or write goes to this Inbox instead.
 */
async function localInstead(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown; id?: unknown };
  if (body.code !== 'id_is_local' || typeof body.id !== 'string') return false;
  rememberLocal([body.id]);
  return true;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  refuseContested(path);
  const machine = forwardedTo(path);
  resumeDebugLog();
  const response = await fetch(path, { headers: { Accept: 'application/json', 'X-Plannotator-Load': pageLoad }, cache: 'no-store', signal });
  learnDebugLog(response);
  if (machine && (await localInstead(response))) return get<T>(localRoute(path), signal);
  const answer = await readJson<T>(response);
  // Local ids come only from this Inbox's own records (list rows, the archived list, thread reads, its own
  // events): any other answer can echo another machine's id (a kept draft names its project).
  if (machine) rememberMachine(idsIn(answer), machine);
  return answer;
}

/**
 * A write to another machine its Inbox could not confirm yet (linked machines, rule 12): held in this Inbox's
 * outbox (`202`), "Sending…" while that machine is online, "Will send when … is back" while it is not. Never
 * "done": the window waits for the outbox's own frame.
 */
export class InboxHeldError extends InboxApiError {
  constructor(
    readonly outbox: OutboxView,
    readonly machine: MachineView | null,
  ) {
    super(202, 'held', heldWords(machine));
    this.name = 'InboxHeldError';
  }
}

/** What a held write says, by its machine's state. */
export function heldWords(machine: Pick<MachineView, 'name' | 'state'> | null): string {
  const name = machine?.name ?? 'the other machine';
  return machine && machine.state !== 'online' && machine.state !== 'connecting'
    ? `Waiting for ${name}: this applies when ${name} is back.`
    : `Sending to ${name}: this applies once ${name} confirms.`;
}

/** A read that gives no answer in `timeoutMs` (a held connection, a stalled server) fails with this. */
export class InboxReadTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'InboxReadTimeout';
  }
}

/**
 * A signal that aborts when `outer` does or after `ms` (then with InboxReadTimeout as its reason). `done` clears the
 * timer once the read settled.
 */
export function signalWithin(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new InboxReadTimeout(ms)), ms);
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** "Ask your agent to look" waits at most this long for the Inbox's facts, then opens the message with what it has. */
export const PROBLEM_FACTS_READ_MS = 4_000;

/** The Inbox's answer for a problem's report (packages/server/inbox-problem-facts.ts). */
export type InboxProblemFacts = ProblemFacts & { thread?: { session: string | null; link: string } };

/** A thread's PRs: the Inbox answers at once from what it knows, so a read with no answer by then is a held connection. */
export const THREAD_PULLS_READ_MS = 10_000;
/** A hover card's data: the Inbox ends a forge CLI at 8 s, so a read with no answer by then is a held connection. */
export const REF_CARD_READ_MS = 20_000;

/** A storage read with no answer by then (a held connection on a phone over the tailnet) fails, so Try again or a reopen reads anew. XL counts in about 1.3 s. */
export const STORAGE_READ_MS = 20_000;

/** `get`, given up after `timeoutMs`: the fetch is aborted and the read fails with InboxReadTimeout. */
async function getWithin<T>(path: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await get<T>(path, controller.signal);
  } catch (cause) {
    throw timedOut ? new InboxReadTimeout(timeoutMs) : cause;
  } finally {
    clearTimeout(timer);
  }
}

/** An action item mark as the window sends it; `quiet`: a note typed under the marked row. */
type ActionMarkBody = { outcome: 'done' | 'cant'; note?: string | null; quiet?: boolean };

function actionMarkBody(mark: ActionMarkBody | null, staged: boolean): Record<string, unknown> {
  return {
    ...(mark ? { outcome: mark.outcome, ...(mark.note ? { note: mark.note } : {}), ...(mark.quiet ? { note_only: true } : {}) } : { outcome: null }),
    ...(staged ? { staged: true } : {}),
  };
}

/** A reply draft save's JSON body (the page's save as it goes builds the same one by hand). */
export function replyDraftSaveBody(body: string, base: string | null, baseBody: string | null, files: ReplyDraftFileOps, recipients?: readonly string[]): Record<string, unknown> {
  // The box's file changes (the Inbox applies them to the draft's files as they are), always sent, even empty:
  // a save without them is an older page's, which names long pastes only. `recipients` (the recipient pill) only
  // once chosen: without it the draft keeps its own.
  return {
    body,
    base,
    ...(baseBody !== null ? { base_body: baseBody } : {}),
    files_add: files.add,
    files_remove: files.remove,
    files_place: files.place,
    ...(recipients !== undefined ? { recipients } : {}),
  };
}

/** The serverSession every POST carries; set from the first list read. */
let pageSession: string | null = null;

export function setPageSession(value: string): void {
  if (pageSession === null) pageSession = value;
}

/**
 * Only the stale page notice's Reload (stalePage.ts `reloadOntoInbox`) calls this. The Inbox restarted under the page,
 * so the saves made before the reload carry the running Inbox's session (only when that Inbox is this page's own);
 * when they do not all land, Reload sets the first session back, so the page's later writes are refused (409) as
 * before. No other code changes the page's session after the first list read.
 */
export function adoptPageSession(value: string): void {
  pageSession = value;
}

/** For a DOM test file that runs after another one in the same process (without `--isolate`) against its own server: the first file's session would otherwise stay. */
export function resetPageSessionForTests(): void {
  pageSession = null;
}

/** The page's serverSession (null before the first list read), for a keepalive request built by hand. */
export function pageServerSession(): string | null {
  return pageSession;
}

/**
 * What a tag in the reply box does (approval "inbox-tag-handoff", A2): `ask`,
 * today's tag (this one reply); `add`, the session joins the thread; `handoff`,
 * it takes the thread over.
 */
export type TagMode = 'ask' | 'add' | 'handoff';

/** Where a referenced file's project-relative path starts: the server finds the folder (packages/server/inbox-open-in.ts). */
/** `from: 'root'`: a diff's path, which starts at the top of the repository wherever the agent stood. */
export type OpenInFileScope = { thread: string; message?: string; from?: 'root' } | { shape: string } | { repo: string; pull?: string };

/** A referenced file's text for its hover: this computer's, or a pull request's at its head commit (`pull`). */
export type OpenInFileCode = { found: false } | { found: true; contents: string; pull?: { label: string; platform: 'github' | 'gitlab'; url: string } };

/** A thread's PRs answer as the window uses it: anything missing reads as none. */
function withProblemChecked(pull: InboxThreadPullWire): InboxThreadPullWire {
  if (!pull || typeof pull !== 'object' || !('problem' in pull)) return pull;
  const { problem, ...rest } = pull;
  const checked = problemOf(problem);
  return checked ? { ...rest, problem: checked } : rest;
}

function threadPullsOf(answer: unknown): InboxThreadPullsAnswer {
  const value = (answer && typeof answer === 'object' ? answer : {}) as Partial<InboxThreadPullsAnswer>;
  return {
    // A PR's problem (newer servers) is kept only when it reads as one; an older server sends none.
    pulls: Array.isArray(value.pulls) ? value.pulls.map(withProblemChecked) : [],
    groups: Array.isArray(value.groups) ? value.groups : [],
    removed: Array.isArray(value.removed) ? value.removed : [],
  };
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  refuseContested(path);
  const machine = forwardedTo(path);
  // A write to another machine is keyed end to end (rule 1): the window's own key, or one made for it here.
  const sent = machine && typeof body.idempotency_key !== 'string' ? { ...body, idempotency_key: newUuid() } : body;
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Plannotator-Load': pageLoad, ...(machine ? threadHeader(path) : {}) },
    body: JSON.stringify(pageSession ? { ...sent, serverSession: pageSession } : sent),
  });
  if (machine && (await localInstead(response))) return post<T>(localRoute(path), body);
  if (machine && response.status === 202) {
    const held = (await response.json().catch(() => ({}))) as { outbox?: OutboxView; machine?: MachineView | null };
    if (held.outbox) {
      const entry = held.outbox;
      // Still on its way: held. A key sent before and already settled (replayed) says how it ended instead.
      if (entry.state === 'queued' || entry.state === 'sending') throw new InboxHeldError(entry, held.machine ?? null);
      if (entry.state === 'delivered') {
        rememberMachine(idsIn(entry.answer), machine);
        return entry.answer as T;
      }
      // Taken back with Cancel: a Send retried with its key never sends it after all.
      if (entry.state === 'cancelled') throw new InboxApiError(409, 'outbox_cancelled', `Cancelled. It was never sent to ${held.machine?.name ?? 'the other machine'}.`);
      const why = entry.answer && typeof entry.answer === 'object' ? (entry.answer as { error?: unknown }).error : null;
      throw new InboxApiError(409, 'not_delivered', typeof why === 'string' && why ? why : `Not delivered to ${held.machine?.name ?? 'the other machine'}.`);
    }
  }
  const answer = await readJson<T>(response);
  // Local ids come only from this Inbox's own records (list rows, the archived list, thread reads, its own
  // events): any other answer can echo another machine's id (a kept draft names its project).
  if (machine) rememberMachine(idsIn(answer), machine);
  return answer;
}

/** The thread a message belongs to, for another machine's messages (learned from its thread reads). */
const threadOfMessage = new Map<string, string>();
/**
 * The thread a forwarded write is about, named to this Inbox in `X-Plannotator-Thread` (kept on the outbox entry, never
 * sent on), so a held answer shows even where that thread cannot open.
 */
function threadHeader(path: string): Record<string, string> {
  const match = /^\/api\/inbox\/m\/ibx_[^/]+\/(messages|threads)\/([^/?]+)/.exec(path);
  if (!match) return {};
  const id = decodeURIComponent(match[2]!);
  const thread = match[1] === 'threads' ? id : threadOfMessage.get(id);
  return thread ? { 'X-Plannotator-Thread': thread } : {};
}
/** The cursor of the last read of another machine's thread: a reply there says what the person saw (rule 11). */
const remoteThreadCursor = new Map<string, number>();

/** `/threads/<id><rest>` on the machine that owns the thread. */
const threadUrl = (threadId: string, rest = '', query?: string) => inboxUrl(`/threads/${encodeURIComponent(threadId)}${rest}`, query, machineOf(threadId));
/** `/messages/<id><rest>` on the machine that owns the message. */
const messageUrl = (messageId: string, rest = '', query?: string) => inboxUrl(`/messages/${encodeURIComponent(messageId)}${rest}`, query, machineOf(messageId));
/** `/attachments/<id><rest>` on the machine that owns the file. */
const attachmentUrl = (attachmentId: string, rest = '', query?: string) => inboxUrl(`/attachments/${encodeURIComponent(attachmentId)}${rest}`, query, machineOf(attachmentId));
/** `/projects/<id><rest>` on the machine that owns the project. */
const projectUrl = (projectId: string, rest = '') => inboxUrl(`/projects/${encodeURIComponent(projectId)}${rest}`, undefined, machineOf(projectId));

/** The merged list names each row's and project's machine: their routes go there from now on (inboxUrl.ts). */
function learnMachines(model: ListModel): void {
  setSelfMachine(model.self);
  const rows = [...model.sections.flatMap((section) => section.threads), ...(model.snoozed ?? [])];
  // This Inbox's own rows and projects first, every id in them (a row's delivery and message ids too): a linked
  // machine's row with the same id never takes one over. Two linked machines naming one id leave it contested.
  rememberLocal(localIdsIn(model));
  for (const row of rows) rememberMachine([row.thread_id], row.machine);
  for (const project of model.projects) rememberMachine([project.id], project.machine);
  // Letter marks (letterMarks.tsx): the projects' names (a Board card names only an id) and their pictures' keys.
  learnProjects(model.projects);
  // The host an owner/repo#123 links on in a thread with no repo: the one most projects use (defaultRefHost.ts).
  learnDefaultRefHost(model.projects);
}

/** A file's query: the page session, and for another machine the key its door asks of every write. */
function fileQuery(machine: string | null | undefined, query = new URLSearchParams()): string | undefined {
  if (pageSession) query.set('serverSession', pageSession);
  if (machine) query.set('idempotency_key', newUuid());
  return query.size > 0 ? query.toString() : undefined;
}

/** A reply to another machine's thread carries the newest seq the person saw there; this Inbox's own replies carry nothing new. */
function seenThrough(messageId: string): { seen_through_seq: number } | Record<string, never> {
  if (!machineOf(messageId)) return {};
  const thread = threadOfMessage.get(messageId);
  const cursor = thread ? remoteThreadCursor.get(thread) : undefined;
  return cursor === undefined ? {} : { seen_through_seq: cursor };
}

/** The window waits this long for the Feedback send: the Inbox answers within FEEDBACK_TIMEOUT_MS (8 s), this only covers an Inbox that does not answer. */
export const FEEDBACK_WINDOW_TIMEOUT_MS = 10_000;

/**
 * The Feedback dialog's Send. Fails with an Error whose message the dialog
 * shows as it is: the Worker's refusal or a validation line from the Inbox,
 * else (Inbox or service unreachable, too slow, failing) the one plain line
 * FEEDBACK_UNAVAILABLE. Never a raw network or status message.
 */
async function sendFeedback(input: { message: string; category: 'bug' | 'idea' | 'other' | null; contact: string | null }): Promise<{ ok: true }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_WINDOW_TIMEOUT_MS);
  const body = { message: input.message, ...(input.category ? { category: input.category } : {}), ...(input.contact ? { contact: input.contact } : {}) };
  try {
    const response = await fetch(inboxUrl('/feedback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(pageSession ? { ...body, serverSession: pageSession } : body),
      signal: controller.signal,
    });
    return await readJson<{ ok: true }>(response);
  } catch (cause) {
    // The Inbox's own words: a validation line (400) or the send's outcome (502 feedback_not_sent).
    if (cause instanceof InboxApiError && (cause.status < 500 || cause.code === 'feedback_not_sent')) throw cause;
    throw new Error(FEEDBACK_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}

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
  /** Newest first instead of best match (sent only for `newest`, so a best-match request is what it was). */
  sort?: InboxSearchSort | null;
}

/** GET /api/inbox/sessions: every live session, grouped by project (compose). */
export interface ComposeSessionsModel {
  serverSession: string;
  home: string;
  projects: InboxComposeProject[];
  /** Asked for with `?session=`: whether that session is still there (with the asker grace). */
  session?: { session: string; live: boolean };
  /** Only while `inboxLaunch.enabled` (on unless false): the agents To offers to start, and the folder menu's projects. */
  launch?: InboxComposeLaunch;
}

/** A draft as the Drafts page lists it, with its chip. */
export type DraftView = InboxDraft & { status: InboxDraftStatus };

/** The folder To names, whose files a sessions read looks at: a project's id, or `SCRATCH_PICK`. */
export interface ComposeTrustPick {
  agent: string;
  project: string;
}

/** `GET /api/inbox/launch/folders`: the folder names in one folder under home, and the path as the server read it (`~/…`). */
export interface HomeFoldersAnswer {
  path: string;
  exists: boolean;
  /** What the path is: a folder, one that can't be opened, a file, or nothing (absent from an older Inbox). */
  state?: 'folder' | 'locked' | 'file' | 'missing';
  folders: string[];
  /** Of `folders`, the ones that can't be opened (absent from an older Inbox). */
  locked?: string[];
  /** A folder can be made in it (absent from an older Inbox, and for a path that isn't a folder). */
  writable?: boolean;
  /** A path that isn't there: the nearest folder above it that is, and its folders (absent from an older Inbox). */
  nearest?: { path: string; folders: string[] };
  /** A missing path under a file or a folder that can't be opened. */
  blocked?: { path: string; state: 'file' | 'locked' };
  /** The folder itself is never started in (home, a folder above it, `/`, the folder drives are in). Absent: it can be. */
  start?: false;
  /** Of `folders`, the ones listed but never started in (absent from an older Inbox). */
  nostart?: string[];
}

/** Clone from a git URL: where that machine would clone it (`GET /api/inbox/launch/clone`), each path as `~/…`. */
export interface CloneTargetAnswer {
  /** The folder the clone goes in. */
  into: string;
  /** The clone's own folder: the repo's name, or the next free `-2`, `-3` (C10). */
  path: string;
  name: string;
  /** `already`: that folder is a clone of the same repo, so it starts there (C9). */
  state: 'clone' | 'already';
  /** The repo's name was another folder's (C10). */
  taken: string | null;
  /** A clone can be made in `into` (C15c). */
  writable: boolean;
}

/** The quiet check after a paste (C11): whether that machine's git can read the repo. */
export type CloneReach = 'ok' | 'auth' | 'not_found' | 'network' | 'failed';

/** What compose sends: a new thread to one live session. */
export interface StartThreadInput {
  /** A live session, or (launch on) a new session of `agent` started in the project, a new scratch folder, or a folder under home (`~/…`); `trust`: Trust and start, on this reading. */
  to: { host: string; session: string } | { launch: ({ agent: InboxLaunchAgent; project_id: string } | { agent: InboxLaunchAgent; scratch: true } | { agent: InboxLaunchAgent; folder: string; create?: true; clone?: { url: string; branch?: string } }) & { trust?: InboxLaunchTrust } };
  body: string;
  idempotency_key: string;
  uploads?: string[];
  draft_id?: string;
  /** The thread's name (its chip): typed by the person (an agent never replaces it), or compose's suggestion with `thread_name_auto`. */
  thread_name?: string;
  /** `thread_name` is compose's suggestion the person left as it was: dropped when it cannot be used, and the agent may rename it. */
  thread_name_auto?: true;
  /** With `thread_name_auto`, from New review: a suggestion another open thread has gets " (2)", " (3)"… instead of being dropped. */
  thread_name_numbered?: true;
  /** Compose's Board chip was on: the agent is asked to track the work on the Board (approval "inbox-compose-board-chip"). */
  board_request?: true;
  /** New review on local changes: what it is of, so its row shows "Curating…" before a review arrives. */
  review?: { kind: 'local'; changes: InboxReviewChanges; branch: string | null; base: string | null; ask: 'guide' | 'custom' } | { kind: 'link'; url: string; title: string; mine: boolean; ask: 'guide' | 'custom' } | { kind: 'walkthrough' };
  /** Asked from Settings -> Decision data: the agent also receives how to answer it. */
  decision_ask?: true;
  /** Settings → Rows' ask box: the agent also receives how to change the rows. */
  rows_ask?: true;
}

/** A file this Inbox already holds, as a pending upload (never another machine's: a thread there offers no reuse). No bytes travel. */
export async function reuseAttachment(attachmentId: string, version: 'current' | 'sent', options: { signal?: AbortSignal; sha256?: string } = {}): Promise<InboxUpload> {
  const response = await fetch(inboxUrl('/uploads/reuse'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachment_id: attachmentId, version, ...(options.sha256 ? { sha256: options.sha256 } : {}), serverSession: pageServerSession() }),
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as { upload?: InboxUpload; error?: string; code?: string };
  if (!response.ok || !body.upload) throw new InboxApiError(response.status, body.code ?? 'error', body.error ?? 'Not attached: that file could not be added.');
  return body.upload;
}

/**
 * Upload one file (compose): the raw bytes, streamed by the browser, with
 * progress. XHR because fetch reports no upload progress. `serverSession`
 * rides the query (the body is the file).
 */
export function uploadFile(
  file: File,
  /** `machine`: a reply to another machine's thread, so the file goes to that machine's Inbox (only while it is online). */
  options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal; machine?: string | null } = {},
): Promise<InboxUpload> {
  return new Promise((resolve, reject) => {
    const query = fileQuery(options.machine, new URLSearchParams({ name: file.name }));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', inboxUrl('/uploads', query, options.machine));
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
  if (request.sort === 'newest') query.set('sort', 'newest');
  return readJson<SearchModel>(await fetch(inboxUrl(`/search?${query}`), { headers: { Accept: 'application/json' }, cache: 'no-store', signal }));
}

/** Remember a search the person opened a result from (the last 6), or forget them all. */
export function saveRecentSearch(input: { q: string } | { clear: true }): Promise<{ recent_searches: string[] }> {
  return post<{ recent_searches: string[] }>(inboxUrl('/search/recent'), input);
}

/** The window's list reads (listRead.ts): `since` names the list it holds; empty asks for the whole list. */
const listReader = createListReader<ListModel>((since) =>
  get<ListReadAnswer<ListModel>>(inboxUrl(`/threads?archived=exclude&snoozed=exclude&machines=1&since=${encodeURIComponent(since)}`)),
);

/** Tests only: the next list read is a whole one. */
export function resetListReads(): void {
  listReader.reset();
}

/** A running app ready to frame: the proxy URL and its bridge token (`GET .../live/:site`, this computer only). */
export interface LiveSiteWire {
  id: string;
  url: string;
  origin: string;
  app_url: string;
  /** What the window frames: the Inbox's same-origin wrapper page, whose only frame is the proxy (`app_url`). */
  frame_url: string;
  proxy_origin: string;
  token: string;
  opened_by: 'agent' | 'person';
}

export const inboxApi = {
  /** Keep a ```html fence's page and get the URL of its sandboxed document (approval "inbox-inline-html"). */
  embed: (html: string) => post<{ id: string; url: string }>(inboxUrl('/embeds'), { html }),
  /** An attached HTML page's frame document, kept by the Inbox and served under its own policy (inbox-pages.ts). */
  page: (html: string) => post<{ id: string; url: string }>(inboxUrl('/pages'), { html }),
  /** The global skills the composers' `/` and `$` picker lists (raw entries; ui's catalog layer normalizes them). */
  skills: () => get<{ skills?: unknown }>(inboxUrl('/skills')),
  /** One human-only skill's SKILL.md, read when the person sends a message that references it. */
  skillContent: (name: string) => get<{ skill?: unknown }>(inboxUrl(`/skills/content?name=${encodeURIComponent(name)}`)),
  // Archived threads leave the window's list (Settings lists them): an older
  // window and the phone, which ask without this, still get them in Quiet.
  // `machines=1`: the merged view (linked machines). An Inbox with nothing linked answers its own list, each row and
  // project naming this Inbox; an older Inbox ignores the parameter.
  // `snoozed=exclude` the same way: snoozed threads come apart from the sections, for the band under Quiet. The rule
  // runs here again with this window's clock, which is the one the person reads the time on.
  // Only the rows changed since the list this window holds, and one read for calls close together (listRead.ts).
  list: () =>
    listReader.read().then((read) => {
      const model = read.snoozed ? { ...read, ...inboxSectionsAsOf(read.sections, read.snoozed) } : read;
      learnMachines(model);
      return model;
    }),
  archived: (input: { project?: string | null; offset?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.project) query.set('project', input.project);
    if (input.offset) query.set('offset', String(input.offset));
    if (input.limit) query.set('limit', String(input.limit));
    const qs = query.toString();
    return get<ArchivedModel>(inboxUrl('/threads/archived', qs)).then((model) => {
      // This Inbox's archived threads: local for good, so no linked machine can claim one.
      rememberLocal(localIdsIn(model));
      return model;
    });
  },
  /** One thread; with `timeoutMs`, a read with no answer by then fails (InboxReadTimeout) instead of waiting for good. */
  // A thread's action items move out of `questions` into `actions` here (actions.ts), so nothing that picks or sends answers meets one.
  thread: (threadId: string, timeoutMs?: number) =>
    (timeoutMs === undefined ? get<ThreadModel>(threadUrl(threadId)) : getWithin<ThreadModel>(threadUrl(threadId), timeoutMs)).then((model) => {
      if (machineOf(threadId)) {
        // Another machine's thread: which thread each message is in, and the newest seq the person now sees there.
        for (const message of model.thread.messages) threadOfMessage.set(message.id, threadId);
        remoteThreadCursor.set(threadId, model.cursor);
      } else {
        // This Inbox's own thread: every id in it is this Inbox's for good.
        rememberLocal(idsIn(model));
      }
      return { ...model, thread: splitThreadActions(model.thread) };
    }),
  /** `store=0`: without the Storage sizes (the server sends them only to a page older than `storage()`). */
  settings: () => get<SettingsModel>(inboxUrl('/settings', 'store=0')),
  /** Settings → Storage's sizes, asked for only while that panel is shown (the server walks every file for them). Given up after STORAGE_READ_MS. */
  storage: () => getWithin<InboxStorageModel>(inboxUrl('/settings/storage'), STORAGE_READ_MS),
  /** Settings -> Decision data's numbers, asked for only while that section is shown. Leaving aborts it, and the server stops counting. */
  decisionData: (days: number, signal: AbortSignal) => get<DecisionDataSummary>(inboxUrl('/decision-data', new URLSearchParams({ days: String(days), tz: String(-new Date().getTimezoneOffset()) }).toString()), signal),
  /** Settings → Activity: each thread's messages by hour over `[from, to)` (this Inbox's store only), one project or all. */
  activity: (from: Date, to: Date, project: string | null) => {
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (project) query.set('project', project);
    return get<InboxActivityModel>(inboxUrl('/activity', query.toString()));
  },
  /** Decision mode (experimental): every decision waiting on the person, in queue order. 404 while the feature is off. */
  decisions: () => get<InboxDecisionsModel>(inboxUrl('/decisions')),
  /** Tidy: who it would ask in the list's (or the Board's) scope, and the last run. */
  tidy: (project: string | null, surface: 'list' | 'board') => {
    const query = new URLSearchParams(surface === 'board' ? { surface } : {});
    if (project) query.set('project', project);
    const qs = query.toString();
    return get<InboxTidyPlan>(inboxUrl('/tidy', qs));
  },
  /** Tidy: ask these sessions. A replay of the key answers the run it wrote. */
  startTidy: (input: { sessions: readonly string[]; idempotency_key: string; project: string | null; surface: 'list' | 'board' }) =>
    post<{ run: InboxTidyRun | null; asked: string[] }>(inboxUrl('/tidy'), { ...input, sessions: [...input.sessions] }),
  saveCookieHost: (on: boolean) => post<{ cookie_host: InboxCookieHost }>(inboxUrl('/settings'), { cookie_host: on }),
  saveExperimental: (change: { decision_mode: boolean }) =>
    post<{ experimental: InboxExperimentalSettings }>(inboxUrl('/settings'), { experimental: change }),
  /** The Board on or off (Settings → Capabilities): agents get the card action from their next session. */
  saveBoard: (on: boolean) => post<{ board: { on: boolean } }>(inboxUrl('/settings'), { board: { on } }),
  /** Thread steps on or off (Settings → Capabilities, approval "inbox-thread-steps"): every window hears `event: capabilities`. */
  saveSteps: (on: boolean) => post<{ steps: { on: boolean } }>(inboxUrl('/settings'), { steps: { on } }),
  saveBro: (on: boolean) => post<{ bro: { on: boolean } }>(inboxUrl('/settings'), { bro: { on } }),
  /** Floating reply drafts on or off (Settings → Capabilities → Experimental): every window hears `event: capabilities`. */
  saveFloatDrafts: (on: boolean) => post<{ float_drafts: { on: boolean } }>(inboxUrl('/settings'), { float_drafts: { on } }),
  /** The Mark read warning's switch ("Don't show this again", and Settings to turn it back on). */
  saveMarkReadWarning: (on: boolean) => post<{ mark_read_warning: { on: boolean } }>(inboxUrl('/settings'), { mark_read_warning: { on } }),
  /** Code review on or off (Settings → Capabilities, approval "inbox-code-review-direction"): every window hears `event: capabilities`. */
  saveCodeReview: (on: boolean) => post<{ code_review: { on: boolean } }>(inboxUrl('/settings'), { code_review: { on } }),
  saveShape: (on: boolean) => post<{ shape: { on: boolean } }>(inboxUrl('/settings'), { shape: { on } }),
  /** System on or off (Settings → Capabilities, under Code review): every window hears `event: capabilities`. */
  saveSystem: (on: boolean) => post<{ system?: { on: boolean } }>(inboxUrl('/settings'), { system: { on } }),
  /** Chapter diagrams on or off (Settings → Capabilities, under Code review): every window hears `event: capabilities`. */
  saveChapterDiagrams: (on: boolean) => post<{ chapter_diagrams?: { on: boolean } }>(inboxUrl('/settings'), { chapter_diagrams: { on } }),
  /** System (on only): the projects with their drawing's state, one project's drawing, and the open PRs that change it. */
  systemProjects: () => get<SystemProjectsAnswer>(inboxUrl('/system/projects')),
  systemDrawing: (project: string) => get<SystemDrawingAnswer<SystemModel>>(inboxUrl(`/system/drawing?project=${encodeURIComponent(project)}`)),
  systemPulls: (project: string) => get<SystemPullsAnswer>(inboxUrl(`/system/pulls?project=${encodeURIComponent(project)}`)),
  /** System's setup dialog (System on only): the projects found on this Mac with a git remote, and one project's save. */
  systemSetup: () => get<SystemSetupAnswer>(inboxUrl('/system/setup')),
  saveSystemSetup: (input: SystemSetupInput) => post<{ setup: SystemSetup }>(inboxUrl('/system/setup'), { ...input }),
  // Shape (packages/server/shape-routes.ts): this computer's boards only, never another machine's.
  shapes: (signal?: AbortSignal) => get<{ shapes: InboxShapeSummary[] }>('/api/shapes?preview=1', signal),
  /** Where a board's kept picture loads from. */
  shapeFileUrl: (id: string, src: string) => `/api/shapes/${encodeURIComponent(id)}/files/${encodeURIComponent(src.replace(/^files\//, ''))}`,
  shape: (id: string, n?: number) => get<ShapeLoadedWire>(`/api/shapes/${encodeURIComponent(id)}${n ? `?n=${n}` : ''}`),
  shapeNote: (id: string, input: Record<string, unknown>) => post<{ note: ShapeNote }>(`/api/shapes/${encodeURIComponent(id)}/notes`, input),
  shapeAnswer: (id: string, input: { re: string; text: string; from: { host: string; id: string } }) => post<{ note: ShapeNote }>(`/api/shapes/${encodeURIComponent(id)}/answer`, input),
  shapeSeen: (id: string, n: number) => post<{ seen: number | null }>(`/api/shapes/${encodeURIComponent(id)}/seen`, { n }),
  shapeCodeFile: (id: string, path: string) => get<{ content: string }>(`/api/shapes/${encodeURIComponent(id)}/code/file?path=${encodeURIComponent(path)}`),
  shapeCodeHover: (id: string, request: Record<string, unknown>) => post<unknown>(`/api/shapes/${encodeURIComponent(id)}/code/hover`, request),
  /**
   * A thread's steps, each session's list with its presence now (approval "inbox-thread-steps"). A linked
   * machine's thread has none here (its read is not forwarded), and an Inbox older than steps answers 404: both
   * read as off.
   */
  threadSteps: async (threadId: string): Promise<{ on: boolean; steps: InboxStepsWire[] }> => {
    if (machineOf(threadId)) return { on: false, steps: [] };
    try {
      const answer = await get<{ on?: unknown; steps?: unknown }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/steps`));
      return { on: answer.on === true, steps: Array.isArray(answer.steps) ? (answer.steps as InboxStepsWire[]) : [] };
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.status === 404) return { on: false, steps: [] };
      throw cause;
    }
  },
  /**
   * A thread's PRs (approval "inbox-pr-binding"): the live list with stack groups and state, and what was removed
   * lately. A linked machine's thread has none here (its read is not forwarded), and an Inbox older than PRs on
   * threads answers 404: both read as none.
   */
  /**
   * "Ask your agent to look": what only the Inbox knows for the report (versions, the tool's recent failed runs,
   * redacted there, and the thread's agent). Given up after PROBLEM_FACTS_READ_MS: the message then opens with less.
   */
  problemFacts: async (query: { clis: readonly string[]; host?: string | null; thread?: string | null }, signal?: AbortSignal): Promise<InboxProblemFacts> => {
    const params = new URLSearchParams();
    for (const cli of query.clis) params.append('cli', cli);
    if (query.host) params.set('host', query.host);
    if (query.thread && !machineOf(query.thread)) params.set('thread', query.thread);
    const within = signalWithin(PROBLEM_FACTS_READ_MS, signal);
    try {
      return await get<InboxProblemFacts>(inboxUrl(`/problem-facts?${params}`), within.signal);
    } finally {
      within.done();
    }
  },
  threadPulls: async (threadId: string, signal?: AbortSignal, options?: { retry?: boolean }): Promise<InboxThreadPullsAnswer> => {
    if (machineOf(threadId)) return { pulls: [], groups: [], removed: [] };
    // Aborted when the card closes or a newer read starts, and given up after THREAD_PULLS_READ_MS: an unanswered
    // read never holds one of the browser's few connections to this Inbox. `retry`: the card's Try again (the
    // server reads a held failure again and waits a little for it; an older server ignores it).
    const within = signalWithin(THREAD_PULLS_READ_MS, signal);
    try {
      return threadPullsOf(await get<unknown>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/pulls${options?.retry ? '?retry=1' : ''}`), within.signal));
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.status === 404) return { pulls: [], groups: [], removed: [] };
      throw cause;
    } finally {
      within.done();
    }
  },
  /** The person adds or removes a thread's PRs (the popover). `remove: ['all']` takes off every one. */
  changeThreadPulls: async (threadId: string, change: { add?: string[]; remove?: string[] }): Promise<InboxThreadPullsAnswer> =>
    threadPullsOf(await post<unknown>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/pulls`), change)),
  /**
   * Post decisions (Export decisions › Post on a pull request, and the PR card's row): the thread's decisions as one
   * comment on one of its PRs, edited in place on a later post. `pull`: the PR as the thread writes it (`ref`).
   */
  postThreadDecisions: (threadId: string, pull: string, tz: string) =>
    post<{ ok: true; action: 'created' | 'updated'; destination: DecisionsPostTo; ref: string; url: string; fallback?: 'no_permission' | 'too_long' }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/decisions/post`), { pull, tz }),
  /** Where Post decisions puts them (config.json `inboxDecisionsPostTo`): the Post group's "Where to post". */
  decisionsPostTo: async (): Promise<DecisionsPostTo> => (await get<{ post_to: DecisionsPostTo }>(inboxUrl('/settings/decisions-post'))).post_to,
  saveDecisionsPostTo: async (postTo: DecisionsPostTo): Promise<DecisionsPostTo> => (await post<{ post_to: DecisionsPostTo }>(inboxUrl('/settings/decisions-post'), { post_to: postTo })).post_to,
  /**
   * The person looked at the thread. `throughSeq`: the seq of the newest
   * message the window showed; the look stops there, so a message that landed
   * after the window read the thread stays new (an older Inbox ignores it).
   */
  seen: (threadId: string, throughSeq?: number | null) =>
    post<{ thread: InboxListRow }>(
      threadUrl(threadId, `/seen`),
      typeof throughSeq === 'number' ? { through_seq: throughSeq } : {},
    ),
  /** Mark read (the thread leaves the top for Quiet, its waiting questions closed) or its Undo. */
  markRead: (threadId: string, read: boolean) =>
    post<{ thread: InboxListRow }>(threadUrl(threadId, `/${read ? 'read' : 'unread'}`), {}),
  /** Mark unread: the thread's latest agent message is new again (New, bold). Nothing is sent to the agent. */
  markUnread: (threadId: string) => post<{ thread: InboxListRow; wrote: boolean; through_seq: number }>(threadUrl(threadId, '/mark-unread'), {}),
  /**
   * 👍 Looks good on the agent's latest message (the thread is marked read; sent to the agent after the Undo window), or its Undo.
   * `reaction`: the emoji picked in the 👍's tray, shown on the message (null: 👍 Looks good); the agent gets the one it ends on when the Undo window closes, and it never changes after that (`409 ack_sent`).
   */
  ack: (messageId: string, on: boolean, reaction?: InboxReaction | null) =>
    post<{ message: InboxMessageWire; thread: InboxListRow }>(messageUrl(messageId, `/ack`), on && reaction !== undefined ? { ack: on, reaction } : { ack: on }),
  /** The project menu's Mark all as read: Mark read on every thread waiting on the person. */
  markProjectRead: (projectId: string, batchId: string) =>
    post<ProjectBatchAnswer<{ read: string[]; looked?: string[] }>>(projectUrl(projectId, `/read`), { batch_id: batchId }),
  /** Its Undo: exactly the threads the batch took (`looked`: those whose Mark read stood, which go back to unread). */
  unmarkProjectRead: (projectId: string, threads: readonly string[], looked: readonly string[] = []) =>
    post<{ threads: InboxListRow[]; skipped: string[] }>(projectUrl(projectId, `/unread`), { threads, looked }),
  /** The project menu's Archive all: every listed thread resolved (one that came back is marked read instead). */
  archiveProject: (projectId: string, batchId: string) =>
    post<ProjectBatchAnswer<{ resolved: string[]; read: string[] }>>(projectUrl(projectId, `/resolve`), { resolved: true, batch_id: batchId }),
  /** Its Undo: exactly the threads the batch took. */
  unarchiveProject: (projectId: string, threads: { resolved: readonly string[]; read: readonly string[] }) =>
    post<{ threads: InboxListRow[]; skipped: string[] }>(projectUrl(projectId, `/resolve`), { resolved: false, threads }),
  /** The project menu's Rename… (a name) and Reset name (null): the project's `display_name`. */
  renameProject: (projectId: string, name: string | null) =>
    post<{ project: ProjectFolder | null }>(projectUrl(projectId, `/name`), { name }),
  /** Set picture… (letter marks): an image as a data: URL, or null to take it away. Answers the project with its `picture`. */
  setProjectPicture: (projectId: string, picture: string | null) =>
    post<{ project: ProjectFolder | null }>(projectUrl(projectId, `/picture`), { picture }),
  /** Combine a project into another, or undo that (null): answers the project the person now sees. */
  combineProject: (projectId: string, into: string | null) =>
    post<{ project: ProjectFolder | null }>(projectUrl(projectId, `/combine`), { into }),
  /** `unsentOnly`: refused (`question_already_sent`) when a reply already sent the question (decision mode, where a pick can race a Send). */
  pick: (messageId: string, key: string, revision: number, answer: QuestionAnswer | null, options: { unsentOnly?: boolean; confirmFull?: boolean } = {}) =>
    post<{ questions: InboxQuestion[] }>(messageUrl(messageId, `/picks`), {
      questions: [{ key, revision, answer }],
      ...(options.unsentOnly ? { unsent_only: true } : {}),
      ...(options.confirmFull ? { confirm_full: true } : {}),
    }).then((result) => ({ ...result, questions: questionsOnly(result.questions) })),
  /**
   * An action item's Done (with an optional note) or Can't do it (with the reason),
   * or taking it back (`null`). `staged` (the thread's checklist; approval
   * "inbox-action-items-in-reply"): it waits in the reply draft and goes with the
   * Send (`reply`'s `actions`). Without it (decision mode): sent to the agent once
   * the Undo window passes. A `quiet` mark (a note typed under the marked row)
   * goes as `note_only`: it never marks again an item taken back meanwhile.
   * Answers the message's action items.
   */
  markAction: (messageId: string, key: string, mark: ActionMarkBody | null, staged = false) =>
    post<{ questions: InboxQuestion[] }>(messageUrl(messageId, `/actions/${encodeURIComponent(key)}`), actionMarkBody(mark, staged)).then(
      (result) => ({ actions: result.questions.filter(isActionRecord) }),
    ),
  /**
   * A staged mark's note as the page goes (a reload, a closed tab) inside its
   * typing pause: a keepalive request, as reply drafts do, so the note is not lost.
   */
  markActionOnLeave: (messageId: string, key: string, mark: ActionMarkBody | null) => {
    const body = actionMarkBody(mark, true);
    void fetch(messageUrl(messageId, `/actions/${encodeURIComponent(key)}`), {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pageSession ? { ...body, serverSession: pageSession } : body),
    }).catch(() => {});
  },
  reply: (
    messageId: string,
    input: {
      idempotency_key: string;
      words: string;
      /** The picks this reply sends; one on another message of the same session names it (`message_id`). */
      questions: { message_id?: string; key: string; revision: number }[];
      feedback?: string;
      annotation_ids?: string[];
      /** The file on screen, on the reply a Send from full screen's floating box writes its words on. */
      viewing?: ReplyViewing;
      /** Another live session takes the reply: the session that asked has ended. */
      to?: { host?: string; session: string };
      /**
       * The open questions the person chose to skip ("Skip them"), on this message or (with
       * `message_id`) another of the same session. A Send never skips anything else.
       */
      skip?: { message_id?: string; key: string }[];
      /** The action items whose Done or Can't do it waits in the draft (approval "inbox-action-items-in-reply"); one on another message of the same session names it. */
      actions?: { message_id?: string; key: string }[];
      /** Files pasted into the reply box (upload ids): attachments on this reply. */
      uploads?: string[];
      /** The sessions the person tagged with `@` (approval "inbox-tag-agents"): each one gets this reply too. */
      tags?: { host?: string | null; session: string; label?: string; mode?: TagMode }[];
      /**
       * This reply carries the reply box's words: their draft goes (approval "inbox-reply-drafts"),
       * named by the `updated_at` they were saved as ('' when not known), or holding exactly these
       * words; a newer, different draft from another window stays.
       */
      clear_draft?: string;
      /** The person's verdict on the review this message carries (Approve / Send feedback in the review's header; Code review on). */
      review_verdict?: 'approved' | 'changes_requested';
    },
  ) =>
    // To another machine: the newest seq the person saw there rides along (rule 11), and a reply its Inbox has not
    // confirmed yet is held (`held`): the Send went into this Inbox's outbox, not into the thread.
    post<ReplyResult>(messageUrl(messageId, `/reply`), { ...input, ...seenThrough(messageId) }).then(
      (result) => {
        noteReplySent(input.words);
        return { ...result, questions: questionsOnly(result.questions) };
      },
      heldReply,
    ),
  /**
   * Re-ask (approval "inbox-reask"): a note asking the session that wrote this
   * message for its open questions again, in one message. `to`: another live
   * session, because the one that asked has ended.
   */
  reask: (messageId: string, input: { idempotency_key: string; to?: { host: string; session: string } }) =>
    post<ReplyResult>(messageUrl(messageId, `/reask`), input).then((result) => ({
      ...result,
      questions: questionsOnly(result.questions),
    }), heldReply),
  /** Take a hand-off back inside its Undo window (approval "inbox-tag-handoff"): the reply goes as an Ask instead. */
  undoHandoff: (messageId: string) => post<{ message: InboxMessageWire }>(messageUrl(messageId, `/handoff/undo`), {}),
  resolve: (messageId: string, resolved: boolean) =>
    post<unknown>(messageUrl(messageId, `/resolve`), { resolved }),
  health: () => get<InboxHealth>(inboxUrl('/health')),
  /** The health, or InboxReadTimeout past `timeoutMs` (the stale page notice's checks and its Reload). */
  healthWithin: (timeoutMs: number) => getWithin<InboxHealth>(inboxUrl('/health'), timeoutMs),
  /** The guided review a message carries: its record and the snapshot (validated by the server, parsed again here). */
  guide: (messageId: string) =>
    get<{ message_id: string; guide: InboxGuideRef; snapshot: unknown }>(messageUrl(messageId, `/guide`)),
  /** One changed file's whole text as the guide's patch names it, for its expand arrows. */
  guideFile: (messageId: string, path: string, signal?: AbortSignal) =>
    get<InboxFileContents>(messageUrl(messageId, `/guide/file`, `path=${encodeURIComponent(path)}`), signal),
  /** The person's reviewed ticks on that guide, kept on the message. */
  saveGuideReviewed: (messageId: string, reviewed: boolean[]) =>
    post<{ message_id: string; reviewed: boolean[] }>(messageUrl(messageId, `/guide/reviewed`), { reviewed }),
  /** The files ticked Viewed in a review (code review in the Inbox), as the patch names them. */
  saveGuideViewed: (messageId: string, viewed: string[]) =>
    post<{ message_id: string; viewed: string[] }>(messageUrl(messageId, `/guide/viewed`), { viewed }),
  /** A comment on that guide's diff (the review app's line comment), new or edited; removed through `removeAnnotation`. */
  saveGuideAnnotation: (messageId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(messageUrl(messageId, `/guide/annotations`), { annotation }),
  /** A comment on the text of an agent's message (the words selected), new or edited; removed through `removeAnnotation`. */
  saveMessageAnnotation: (messageId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(messageUrl(messageId, `/annotations`), { annotation }),
  // A question choice's running-app prototype, through the live proxy (packages/server/inbox-live.ts). `probe`: the
  // app is asked first, so a stopped one answers 422 live_not_answering instead of the proxy framing its error.
  liveSite: (threadId: string, siteId: string, probe = false) =>
    get<{ site: LiveSiteWire }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/live/${encodeURIComponent(siteId)}${probe ? '?probe=1' : ''}`)),
  pingLiveSite: (threadId: string, siteId: string) =>
    post<{ running: boolean }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/live/${encodeURIComponent(siteId)}/ping`), {}),
  saveLiveAnnotation: (threadId: string, siteId: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/live/${encodeURIComponent(siteId)}/annotations`), { annotation }),
  restart: () => post<{ ok: true }>(inboxUrl('/restart'), {}),
  // The update control: the dialogs' facts, Update now, Remind me tomorrow, Check now, What's new.
  updateDetails: () => get<UpdateDetails>(inboxUrl('/update')),
  updateNow: () => post<{ ok: true; version: string; update: InboxHealth['update'] }>(inboxUrl('/update'), {}),
  snoozeUpdate: () => post<{ ok: true; update: InboxHealth['update'] }>(inboxUrl('/update/snooze'), {}),
  checkForUpdate: () => post<UpdateDetails & { checked: { ok: boolean; error?: string } }>(inboxUrl('/update/check'), {}),
  /** `retry`: the person's Try again, which asks GitHub whatever the throttle says. */
  whatsNew: (version: string, retry = false) =>
    get<WhatsNewModel>(inboxUrl(`/whats-new?version=${encodeURIComponent(version)}${retry ? '&retry=1' : ''}`)),
  whatsNewReleases: () => get<WhatsNewReleasesModel>(inboxUrl('/whats-new/releases')),
  saveUpdateSwitches: (change: { update_check?: boolean; auto_update?: boolean }) =>
    post<{ updates: UpdateSwitches }>(inboxUrl('/settings'), change),
  saveInboxTool: (hosts: Partial<Record<AgentToolHost, boolean>>) =>
    post<{ inbox_tool: SettingsModel['inbox_tool'] }>(inboxUrl('/settings'), { inbox_tool: hosts }),
  saveNotifications: (change: Partial<NotificationSettings>) =>
    post<{ notifications: NotificationSettings }>(inboxUrl('/settings'), { notifications: change }),
  /**
   * This window's notification permission for its own origin (notify.ts); an
   * older Inbox answers 404. Sent without the page's serverSession on purpose:
   * it changes nothing the person decided, and it must reach an Inbox that
   * restarted under this tab (whose serverSession is new) so the count of
   * windows that may notify is right again.
   */
  reportWindow: async (report: { window: string; permission: Exclude<InboxWindowPermission, 'unknown'>; origin: string; served_by?: string | null }) =>
    readJson<{ notify_reach: InboxNotifyReach }>(
      await fetch(inboxUrl('/window'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(report),
      }),
    ),
  saveSound: (change: { enabled?: boolean; volume?: number }) => post<{ sound: InboxSoundSettings }>(inboxUrl('/settings'), { sound: change }),
  /** Ask to show the one-time sound dialog: `show` is true for the first page that ever asks after an update, and only that one. */
  claimSoundDialog: () => post<{ show: boolean; sound: InboxSoundSettings }>(inboxUrl('/sound/dialog'), {}),
  /**
   * The sidebar's Feedback dialog: the person's words go to the feedback Worker through this Inbox's server
   * (packages/server/inbox-feedback.ts), which adds the version, the OS name and the names of the agents used, and nothing else.
   */
  sendFeedback: (input: { message: string; category: 'bug' | 'idea' | 'other' | null; contact: string | null }) => sendFeedback(input),
  /** Plannotator's appearance, written to config.json `theme` (shared with plan review). */
  saveTheme: (theme: InboxThemeConfig) => post<{ theme: InboxThemeConfig | null }>(inboxUrl('/settings'), { theme }),
  /** The onboarding tour: each `true` stamps now (started, finished, skipped); `notify_again` sets the first thread's ask. */
  saveTour: (change: InboxTourChange) => post<{ tour: InboxTourState }>(inboxUrl('/settings'), { tour: change }),
  /** Settings → Prompts: set (a string) or delete (null) the Inbox reminder, shared or one agent's. */
  savePrompts: (change: InboxPromptsChange) => post<{ prompts: InboxPromptsSettings }>(inboxUrl('/settings'), { prompts: change }),
  /** The tour's curated fixture (packages/inbox/tour/content/fixture.json), served from the binary on demand. */
  tourFixture: () => get<unknown>(inboxUrl('/tour/fixture.json')),
  /** The favicon, written to config.json `favicon` (shared with plan review, code review and annotate). */
  saveFavicon: (favicon: FaviconStyle) => post<{ favicon: FaviconStyle }>(inboxUrl('/settings'), { favicon }),
  /** The window's text size, written to config.json `inboxTextSize`. */
  saveTextSize: (textSize: InboxTextSize) => post<{ text_size: InboxTextSize }>(inboxUrl('/settings'), { text_size: textSize }),
  /**
   * One change to the reaction tray's saved emoji, applied by the server to config.json `inboxReactions` as it is
   * now (another window's change kept); every window open hears the list (`event: reactions`).
   */
  changeReaction: (change: InboxReactionChange) => post<{ reactions: InboxReaction[]; reactions_rev: number }>(inboxUrl('/settings'), { reaction_change: change }),
  /** How the list's rows look, written to config.json `inboxRows`: every window open hears it (`event: rows`). */
  saveRows: (rows: readonly InboxRowsOption[]) => post<{ rows: InboxRowsOption[]; rows_rev: number }>(inboxUrl('/settings'), { rows }),
  /** The sidebar's layout, written to config.json `inboxSidebar`: every window open hears it (`event: sidebar`). */
  saveSidebar: (sidebar: InboxSidebarLayout) => post<{ sidebar: unknown; sidebar_rev: number }>(inboxUrl('/settings'), { sidebar }),
  /** How diffs are drawn, written to config.json `diffOptions` (shared with code review): only the fields given. */
  saveDiffOptions: (change: Partial<InboxDiffOptions>) =>
    post<{ diff_style: InboxDiffStyle | null; diff_options: InboxDiffOptions }>(inboxUrl('/settings'), { diff_options: change }),
  saveTailscale: (on: boolean, replaceExposed = false) =>
    post<{ tailscale: TailscaleSettings }>(inboxUrl('/settings'), { tailscale: replaceExposed ? { on, replace_exposed: true } : { on } }),
  // Step 2: attachments (by id only), annotations, deleting.
  attachments: (threadId: string) => get<AttachmentsModel>(threadUrl(threadId, `/attachments`)),
  view: (attachmentId: string, version: 'current' | 'sent') =>
    get<AttachmentView>(attachmentUrl(attachmentId, `/view${version === 'sent' ? '?version=sent' : ''}`)),
  /** A page an attached HTML page links to (not attached itself), by a path relative to that page's folder: read-only. */
  linkedPage: (attachmentId: string, path: string) =>
    get<LinkedPageView>(attachmentUrl(attachmentId, `/linked-page?path=${encodeURIComponent(path)}`)),
  saveAnnotation: (attachmentId: string, version: string, annotation: object) =>
    post<{ annotation: InboxAnnotationRecord }>(inboxUrl('/annotations', undefined, machineOf(attachmentId)), { attachment_id: attachmentId, version, annotation }),
  removeAnnotation: (id: string) =>
    post<{ annotation: InboxAnnotationRecord }>(inboxUrl(`/annotations/${encodeURIComponent(id)}/remove`, undefined, machineOf(id)), {}),
  /** "Open in": the file as it is now, in a catalog app or the default app, by the attachment's id (on this computer only). */
  openIn: (attachmentId: string, appId: string) =>
    post<{ ok: boolean; error?: string }>(inboxUrl('/open-in'), { attachment_id: attachmentId, app_id: appId }),
  /** A referenced file in its scope: whether it is on this computer, its real path and kind. 403 through the tailnet. */
  openInFileCheck: (scope: OpenInFileScope, path: string) =>
    get<{ found: boolean; path?: string; kind?: string }>(inboxUrl(`/open-in/file?${new URLSearchParams({ ...scope, path })}`)),
  openInFileCode: (scope: OpenInFileScope, path: string) => get<OpenInFileCode>(inboxUrl(`/open-in/file/code?${new URLSearchParams({ ...scope, path })}`)),
  openInFile: (scope: OpenInFileScope, path: string, appId: string, line?: number) =>
    post<{ ok: boolean; error?: string }>(inboxUrl('/open-in/file'), { ...scope, path, app_id: appId, ...(line ? { line } : {}) }),
  /** Keep a marked-up image (a comment drawn on an image attachment): its path rides the comment's `images`. */
  // `machine`: the drawing is of another machine's file, so it is kept there (it is sent while that machine is online).
  uploadMarkup: async (image: Blob, machine?: string | null) =>
    readJson<{ path: string; name: string; url: string }>(
      await fetch(inboxUrl('/markups', fileQuery(machine), machine), {
        method: 'POST',
        headers: { 'Content-Type': image.type || 'image/png', Accept: 'application/json' },
        body: image,
      }),
    ),
  deleteThread: (threadId: string) => post<{ store: InboxStorageModel }>(threadUrl(threadId, `/delete`), {}),
  // Step 8: New message to a live session of the thread's project.
  // Compose: every live session, a new thread, Send to another session, and drafts.
  /** `machine`: a linked machine's sessions and launch block, read through the forward (remote launch); absent: this Inbox's. */
  composeSessions: (session?: string | null, trust?: ComposeTrustPick | null, machine?: string | null) => {
    const query = new URLSearchParams({ ...(session ? { session } : {}), ...(trust ? { trust_agent: trust.agent, trust_project: trust.project } : {}) }).toString();
    return get<ComposeSessionsModel>(inboxUrl('/sessions', query || undefined, machine));
  },
  /**
   * "Another folder on <machine>…": the folder names in one folder on that machine (`GET
   * /api/inbox/launch/folders?path=~/…` or a full path), one level, no hidden or system ones. `machine`: a linked
   * machine's, through the forward; null: this computer's. A path that isn't there is `exists: false`; a hidden or
   * system one is a 422 (`folder_hidden`, `folder_system`; an older Inbox's `folder_outside_home`), a drive that
   * doesn't answer a 504 (`folder_slow`; `fresh`: Try again, asked of the drive at once), a guest or a call from
   * outside the window a 403.
   */
  homeFolders: (path: string, machine?: string | null, signal?: AbortSignal, fresh = false) =>
    get<HomeFoldersAnswer>(inboxUrl('/launch/folders', new URLSearchParams({ path, ...(fresh ? { fresh: '1' } : {}) }).toString(), machine), signal),
  /**
   * "Choose in Finder…": macOS's folder dialog on this computer (this computer's own window only). The folder picked
   * as a full path, or `cancelled`.
   */
  chooseFolder: () => post<{ path?: string; cancelled?: true }>(inboxUrl('/launch/choose-folder'), {}),
  /** Clone from a git URL: where `url` would be cloned on that machine (`into` absent: its default clone folder, C1). */
  cloneTarget: (url: string, into: string | null, machine?: string | null, signal?: AbortSignal) =>
    get<CloneTargetAnswer>(inboxUrl('/launch/clone', new URLSearchParams({ url, ...(into ? { into } : {}) }).toString(), machine), signal),
  /** The quiet check after a paste (C11): that machine's git reads the repo's branches, with no prompt. */
  cloneCheck: (url: string, machine?: string | null, signal?: AbortSignal) =>
    get<{ reach: CloneReach }>(inboxUrl('/launch/clone-check', new URLSearchParams({ url }).toString(), machine), signal),
  /** `machine`: start the agent on that linked machine (remote launch), through the forward; a `202` is `InboxHeldError`. */
  startThread: (input: StartThreadInput, machine?: string | null) =>
    post<{ thread_id: string; message: InboxMessage; project?: { id: string; name: string; root: string }; replayed: boolean; launch?: { id: string; state: 'starting' | 'failed' } }>(inboxUrl('/messages', undefined, machine), { ...input }),
  // Launch (behind `inboxLaunch.enabled`, on unless false): the run line's buttons and Settings → Agents' switches.
  launchStop: (launchId: string, machine?: string | null) => post<{ run: InboxRun | null }>(inboxUrl(`/launch/${encodeURIComponent(launchId)}/stop`, undefined, machine), {}),
  launchOpen: (launchId: string) => post<{ ok: true; command: string }>(inboxUrl(`/launch/${encodeURIComponent(launchId)}/open`), {}),
  launchDelete: (launchId: string, machine?: string | null) => post<{ ok: true; scratch_removed?: boolean }>(inboxUrl(`/launch/${encodeURIComponent(launchId)}/delete`, undefined, machine), {}),
  launchRetry: (launchId: string, machine?: string | null) => post<{ run: InboxRun | null }>(inboxUrl(`/launch/${encodeURIComponent(launchId)}/retry`, undefined, machine), {}),
  /** `warning`: the line the person read (`run.trust.warning`): a server that now reads another saves nothing. */
  launchTrust: (launchId: string, warning: string | null, machine?: string | null) => post<{ run: InboxRun | null }>(inboxUrl(`/launch/${encodeURIComponent(launchId)}/trust`, undefined, machine), { warning }),
  /** Settings → Agents, shown: the switch as it stands (never set: the login shell read again when stale). */
  /** `ahead`: the composer picked "Start Claude Code": read the login shell now (switch never set), so the Send need not wait. */
  /** Settings → Agents' Codex account line: read from Codex on this computer (the plan and its limits), never polled. */
  codexAccount: () => get<{ account: InboxCodexAccount }>(inboxUrl('/codex/account')),
  launchSettingsRead: (ahead = false) => get<{ launch: InboxLaunchSettings }>(inboxUrl(ahead ? '/launch/settings?ahead=1' : '/launch/settings')),
  launchSettings: (fullPermissions: boolean) => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { full_permissions: fullPermissions }),
  /** Settings → Agents' "Start agents from New message": writes config.json `inboxLaunch.enabled`; New message follows at once. */
  launchEnabled: (enabled: boolean) => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { enabled }),
  /** Settings → Agents' "Scratch folders": a full path (`~/…` too), or null for the default. */
  launchScratchDir: (path: string | null) => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { scratch_dir: path }),
  readdress: (messageId: string, to: { host: string; session: string }) =>
    post<{ message: InboxMessage; row: InboxListRow | null }>(messageUrl(messageId, `/to`), { to }),
  /** `replies` (additive): open threads holding unsent work; an older Inbox sends none. */
  drafts: () => get<{ serverSession: string; drafts: DraftView[]; replies?: InboxReplyDraftRow[] }>(inboxUrl('/drafts')),
  // Reply drafts (approval "inbox-reply-drafts"): the reply box's words per thread.
  replyDraft: (threadId: string) => get<{ draft: InboxReplyDraft | null }>(threadUrl(threadId, `/draft`)),
  /** Save (compare-and-set on `base`, the `updated_at` last read; null to create); an empty body deletes it. */
  /**
   * `files`: the box's file changes since it last held the draft's files (`files_add`, `files_remove`,
   * `files_place`); the Inbox applies them to the draft's files as they are and answers the result. Only
   * different words refuse a save (`base_body`: the words this window saved last).
   */
  saveReplyDraft: (threadId: string, body: string, base: string | null, baseBody: string | null = null, files: ReplyDraftFileOps = NO_FILE_OPS, recipients?: readonly string[]) =>
    post<{ draft: InboxReplyDraft | null }>(threadUrl(threadId, `/draft`), replyDraftSaveBody(body, base, baseBody, files, recipients)),
  /** A pending pasted-text upload's words (Put back after a reload, or in another window); `machine`: another machine's thread. */
  uploadText: (uploadId: string, machine: string | null = null) =>
    get<{ text: string }>(inboxUrl(`/uploads/${encodeURIComponent(uploadId)}/text`, undefined, machine)),
  // Pins (approval "inbox-pinned-threads"): the sidebar's pinned threads.
  /** Pin a thread (at the bottom of Pinned) or unpin it. */
  /** The Board's cards (approval "inbox-board", step 2): every card, the agents' unseen drops, the person's last look. */
  cards: () => get<CardsModel>(inboxUrl('/cards')),
  /**
   * The person's New card: a title, notes and links, in Backlog (or Todo); or sent: `thread_id` is
   * the thread compose's Send just started for it (the card lands in Todo, in that thread's project).
   */
  createCard: (input: {
    project?: string | null;
    title: string;
    notes?: string | null;
    column?: 'backlog' | 'todo';
    refs?: string[];
    thread_id?: string;
    idempotency_key?: string;
    /** The initiative the Board is filtered to: the new card starts in it. */
    initiative?: string | null;
  }) => post<{ card: InboxCardWire; replayed: boolean }>(inboxUrl('/cards'), { ...input }),
  /** The card's initiative (an `ini_` id), or none (null). */
  setCardInitiative: (id: string, initiative: string | null) =>
    post<{ card: InboxCardWire }>(inboxUrl(`/cards/${encodeURIComponent(id)}`), { op: 'initiative', initiative }),
  /** A new initiative, named. */
  createInitiative: (name: string) => post<{ initiative: InboxInitiative }>(inboxUrl('/initiatives'), { name }),
  /** An initiative renamed, or deleted (its cards read as in none). */
  changeInitiative: (id: string, change: { op: 'rename'; name: string } | { op: 'delete' } | { op: 'restore' }) =>
    post<{ initiative: InboxInitiative }>(inboxUrl(`/initiatives/${encodeURIComponent(id)}`), change),
  /** The person's move: `move` to a column, `drop` (Cancel, reason optional), `restore`. */
  moveCard: (id: string, change: { op: 'move'; column: InboxCardColumn } | { op: 'drop'; reason?: string | null } | { op: 'restore' }) =>
    post<{ card: InboxCardWire }>(inboxUrl(`/cards/${encodeURIComponent(id)}`), change),
  /** The opened card's edits: title, notes; a link (a thread, an issue or PR); sent to an agent (the thread just started). */
  editCard: (id: string, change: { op: 'edit'; title?: string; notes?: string | null } | { op: 'link'; thread_id?: string; ref?: string } | { op: 'send'; thread_id: string }) =>
    post<{ card: InboxCardWire }>(inboxUrl(`/cards/${encodeURIComponent(id)}`), change),
  /** The opened card: the card and its history, newest first, and its project's repo (absent from an older Inbox). */
  card: (id: string) => get<{ card: InboxCardWire; history: InboxCardHistoryEntry[]; repo?: InboxProjectRepo | null }>(inboxUrl(`/cards/${encodeURIComponent(id)}`)),
  /** The opened card's links, resolved now (read only). */
  cardRefs: (id: string) => get<{ refs: { ref: InboxCardRef; result: ForgeRefCardResult }[] }>(inboxUrl(`/cards/${encodeURIComponent(id)}/refs`)),
  /** The person opened the Board: the look runs through the cursor of the read it showed (the server clamps it). */
  /** The lane cards' marks (their one linked PR or issue's state), for the cards on screen; `refresh` when the window got its focus back. */
  cardMarks: (ids: readonly string[], refresh = false) => post<{ marks: Record<string, InboxCardMark> }>(inboxUrl('/cards/marks'), { cards: [...ids], refresh }),
  /** Pull requests (Code review on only): the PRs of the projects' repositories and their agents' threads; `refresh` reads the forges again. */
  /** `others`: the Others view is open, so the server reads Others as often as the list (else every 5 min at most). */
  /** `everywhere`: the Pull requests page, the person's own PRs in any repository (approval "inbox-pr-dashboard"). */
  pulls: (refresh = false, signal?: AbortSignal, others = false, everywhere = false) => {
    const query = [refresh ? 'refresh=1' : '', others ? 'others=1' : '', everywhere ? 'everywhere=1' : ''].filter(Boolean).join('&');
    return get<InboxPullsAnswer>(inboxUrl(`/pulls${query ? `?${query}` : ''}`), signal);
  },
  /** The Reviews rows (Code review on only). `others`: the Others view is open, as `pulls` asks. */
  reviews: (options: { others?: boolean } = {}, signal?: AbortSignal) => {
    const query = options.others ? 'others=1' : '';
    return get<InboxReviewsAnswer>(inboxUrl(`/reviews${query ? `?${query}` : ''}`), signal);
  },
  /** The rows again from what the forges last answered, with no forge read; `cold`: nothing read since the Inbox started. */
  reviewsCached: (signal?: AbortSignal) => get<InboxReviewsAnswer | { cold: true }>(inboxUrl('/reviews?cached=1'), signal),
  /** PR risk ranking: the rules, the risk agent and the judgments of the listed PRs (inbox-pull-risk.ts). */
  pullRisk: (signal?: AbortSignal) => get<InboxPullRiskAnswer>(inboxUrl('/pulls/risk'), signal),
  savePullRisk: (input: { rules: string; provider: string | null; model: string | null }) => post<InboxPullRiskAnswer>(inboxUrl('/pulls/risk'), input),
  pullRiskModels: (provider: string, signal?: AbortSignal) => get<InboxPullRiskModels>(inboxUrl(`/pulls/risk/models?provider=${encodeURIComponent(provider)}`), signal),
  /** A PR author's profile picture, served by the Inbox from its own origin (only an author the last list returned). */
  pullDetails: (key: string, signal?: AbortSignal) => get<InboxPullDetailsAnswer>(inboxUrl(`/pulls/details?key=${encodeURIComponent(key)}`), signal),
  pullAvatarUrl: (host: string, login: string) => inboxUrl('/pulls/avatar', `host=${encodeURIComponent(host)}&login=${encodeURIComponent(login)}`),
  /** One layer's diff, or the stack's from its base up to that layer (a PR the last list named). */
  pullDiff: (key: string, scope: InboxPullDiffScope, signal?: AbortSignal) =>
    get<InboxPullDiffAnswer>(inboxUrl(`/pulls/diff?key=${encodeURIComponent(key)}&scope=${scope}`), signal),
  /** New review's Pull request link: what the pasted link is. */
  reviewLink: (ref: string, signal?: AbortSignal) => get<InboxReviewLinkAnswer>(inboxUrl(`/reviews/link?ref=${encodeURIComponent(ref)}`), signal),
  /** New review's change summary for a project's local changes. */
  reviewChanges: (project: string, changes: InboxReviewChanges, signal?: AbortSignal) => get<InboxReviewChangesAnswer>(inboxUrl(`/reviews/changes?project=${encodeURIComponent(project)}&changes=${changes}`), signal),
  /** One changed file's whole text at both ends of that diff, for its expand arrows, while it is the blobs (`old`, `new`) the patch on screen names. */
  pullFile: (key: string, scope: InboxPullDiffScope, path: string, ids: PatchBlobIds, signal?: AbortSignal) =>
    get<InboxFileContents>(inboxUrl(`/pulls/file?key=${encodeURIComponent(key)}&scope=${scope}&path=${encodeURIComponent(path)}&old=${ids.oldId}&new=${ids.newId}`), signal),
  /** The person started a PR's (a stack's open layers') review thread with an agent: `threadId` is the thread the review picker (or compose's New thread) just started for it. */
  pullOwner: (keys: readonly string[], threadId: string, ask?: 'guide' | 'custom') => post<{ ok: true }>(inboxUrl('/pulls/owner'), { keys: [...keys], thread_id: threadId, ...(ask ? { ask } : {}) }),
  /** Before a hand-off is sent: may these PRs go to an agent in `projectId`? (404 `pull_unknown`, 422 another project's.) */
  /**
   * Post a review to the PR on GitHub/GitLab (`POST /api/inbox/pulls/review`): the raw answer, which the review app's
   * own submit (`submitPlatformReviewTargets`, through `#platform-post`) reads as it reads `/api/pr-action`'s. The
   * review app's page session is not this window's: the Inbox's own goes instead.
   */
  pullReviewPost: (request: Record<string, unknown>): Promise<Response> => {
    const { serverSession: _theirs, ...rest } = request;
    return fetch(inboxUrl('/pulls/review'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(pageSession ? { ...rest, serverSession: pageSession } : rest),
    });
  },
  /** Merge a PR the person confirmed (the popover's second click), at the head they saw. The server asks the forge first. */
  pullMerge: (key: string, headSha: string) => post<{ ok: true; key: string; method: 'merge' | 'squash' | 'rebase' | null; url: string }>(inboxUrl('/pulls/merge'), { key, head_sha: headSha, confirmed: true }),
  pullOwnerCheck: (keys: readonly string[], projectId: string) => post<{ ok: true }>(inboxUrl('/pulls/owner'), { keys: [...keys], project_id: projectId, validate_only: true }),
  seeBoard: (throughSeq: number) => post<{ seen_seq: number }>(inboxUrl('/cards/seen'), { through_seq: throughSeq }),
  /** The Board's first-visit dialog: the first page on this computer to ask gets `show: true`, once per machine. */
  claimBoardIntro: () => post<{ show: boolean }>(inboxUrl('/board/intro'), {}),
  /** The one-time list options dialog: only the first claim ever gets `show: true` (once per machine). */
  claimListIntro: () => post<{ show: boolean; list_intro: { due: boolean } }>(inboxUrl('/list-intro'), {}),
  /** The one-time voice announcement, as the list options dialog; the Inbox also checks this computer's Codex login. */
  claimVoiceIntro: () => post<{ show: boolean }>(inboxUrl('/voice/intro'), {}),
  /** The one-time Snooze announcement, as the list options dialog: only the first claim ever gets `show: true`. */
  claimSnoozeIntro: () => post<{ show: boolean; snooze_intro: { due: boolean } }>(inboxUrl('/snooze-intro'), {}),
  /**
   * A reveal for returning users: `show: true` only while it is still next (a compare-and-set over the queue). It turns
   * nothing on. `key`: the page's own for this claim, so a retry after a lost answer is shown it again (Board, Checklist).
   */
  claimReveal: (id: InboxRevealClaimId, key?: string, agents?: readonly string[]) =>
    post<{ show: boolean; reveal: { next: InboxRevealId | null }; board: { on: boolean }; steps?: { on: boolean }; star?: { can_star: boolean } }>(inboxUrl('/reveal'), {
      id,
      ...(key ? { key } : {}),
      // The agent note: the agents it would ask about (it shows once for each).
      ...(agents && agents.length > 0 ? { agents } : {}),
    }),
  /**
   * An offer of the line closed with Not now (or Escape, or a click outside) without taking it: the next one waits three
   * days. Offers only (an update-day dialog's Not now keeps the usual one). Best effort: a lost answer only shortens that wait.
   */
  revealNotNow: (id: InboxRevealOfferId) => post<{ show: boolean }>(inboxUrl('/reveal'), { id, answer: 'not_now' }).then(
    () => undefined,
    () => undefined,
  ),
  /**
   * The "Star the repo" ask (packages/shared/star-ask.ts), once claimed through the line (`claimReveal('star')`):
   * `star` stars it with the person's own gh (only on their click), `answer` records Not now (the line's three-day
   * wait too) or the GitHub page opened from the link.
   */
  starAskStar: () => post<{ starred: boolean }>(inboxUrl('/star-ask'), { action: 'star' }),
  starAskAnswer: (answer: 'not-now' | 'opened') =>
    post<{ ok: boolean }>(inboxUrl('/star-ask'), { action: 'answer', answer }).then(
      () => undefined,
      () => undefined,
    ),
  saveVoice: (change: { on?: boolean; phones_only?: boolean; engine?: InboxVoiceEngine }) => post<{ voice: InboxVoiceSettings }>(inboxUrl('/settings'), { voice: change }),
  /** Only on this computer; the answer never holds the key. Null removes it. */
  saveVoiceKey: (key: string | null) => post<{ key: InboxVoiceKeyState }>(inboxUrl('/voice/key'), { key }),
  voiceStatus: (fresh: boolean) => get<InboxVoiceStatus>(inboxUrl('/voice/status', fresh ? 'fresh=1' : undefined)),
  /**
   * The clip, to the Inbox that serves this window: never a `machine`, so audio is never forwarded, even for a thread
   * on a linked machine. A failure is an answer here, not a throw; only an Inbox that can't be reached throws.
   */
  transcribeVoice: async (clip: Blob, signal: AbortSignal): Promise<{ text: string } | { code: InboxVoiceFailure | null; engine?: InboxVoiceEngine; reason?: InboxVoiceStatus['state'] }> => {
    const response = await fetch(inboxUrl('/voice/transcribe', pageSession ? `serverSession=${encodeURIComponent(pageSession)}` : undefined), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', Accept: 'application/json' },
      body: clip,
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as { text?: unknown; code?: unknown; engine?: InboxVoiceEngine; reason?: InboxVoiceStatus['state'] };
    if (response.ok && typeof body.text === 'string') return { text: body.text };
    const code = typeof body.code === 'string' && body.code.startsWith('voice_') ? (body.code as InboxVoiceFailure) : null;
    return { code, engine: body.engine, reason: body.reason };
  },
  /** The person looked at Dropped: an agent's drops there are seen. */
  seeDrops: (ids: readonly string[]) => post<{ cards: InboxCardWire[] }>(inboxUrl('/cards/dropped/seen'), { cards: [...ids] }),
  /** Every pinned artifact (approval "inbox-artifact-stars"; not the sidebar's thread pins), in pin order. This machine's threads only. */
  artifactPins: () => get<{ pins: InboxArtifactPin[] }>(inboxUrl('/artifact-pins')),
  /** The face each agent's icon shows (inbox/agent-faces.json, agents/agentFaces.ts). This window's Inbox only. */
  agentFaces: () => get<unknown>(inboxUrl('/agent-faces')),
  /** One agent's face (`agent`: its own mark again), or this browser's faces from before (`adopt`); every window hears it (`event: agent-faces`). */
  saveAgentFace: (change: InboxAgentFaceChange) => post<unknown>(inboxUrl('/agent-faces'), change as Record<string, unknown>),
  /** "Your own…": keep an uploaded picture for agents' icons (a data: URL, as Set picture… sends); answers `{ icon, faces, rev, icons }`. */
  uploadAgentIcon: (picture: string) => post<{ icon?: { id?: unknown } } & Record<string, unknown>>(inboxUrl('/agent-icons'), { picture }),
  /** Take an uploaded picture away: the agents showing it go back to their own mark. Answers `{ faces, rev, icons }`. */
  removeAgentIcon: (id: string) => post<unknown>(inboxUrl('/agent-icons'), { remove: id }),
  /** "Animate it": a request an agent's hand-back names (`{ request }`), for this agent and the picture it shows. */
  askIconAnimate: (animate: { icon: string; agent: string; sessions: string[] }) => post<{ request?: unknown }>(inboxUrl('/icon-animate'), { animate }),
  /** Pictures agents handed back and the originals they replaced (`{ results: [{ icon, result }] }`): "Use the original". */
  iconAnimateResults: () => get<{ results?: unknown }>(inboxUrl('/icon-animate')),
  /** The icon sets for agents' icons ("Sets"): built in, then fetchable (`remote`: the pointer is read too; the picker's Sets only). */
  iconSets: (remote: boolean) => get<{ sets?: unknown }>(inboxUrl('/icon-sets', remote ? 'remote=1' : undefined)),
  /** One set's icons (a fetchable one's `have`: the icons kept so far). */
  iconSet: (id: string) => get<unknown>(inboxUrl(`/icon-sets/${encodeURIComponent(id)}`)),
  /** "Get": download a fetchable set into this Inbox's data folder (a stopped one resumes). */
  getIconSet: (id: string) => post<{ set?: unknown }>(inboxUrl('/icon-sets'), { get: id }),
  /** Pin one artifact of a thread (its key: an attachment id, or `guide:<message id>`), or unpin it. */
  setArtifactPinned: (threadId: string, key: string, pinned: boolean) => post<{ pins: InboxArtifactPin[] }>(inboxUrl('/artifact-pins'), { thread_id: threadId, key, pinned }),
  /** The Artifacts wall: a page of every thread's artifacts, newest first. */
  artifacts: (query: { pinned?: boolean; type?: InboxArtifactType | null; archived?: boolean; cursor?: string | null; limit?: number }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.pinned) params.set('pinned', '1');
    if (query.type) params.set('type', query.type);
    params.set('archived', query.archived ? 'include' : 'exclude');
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    return get<InboxArtifactsPage & { serverSession: string }>(inboxUrl('/artifacts', params.toString()), signal);
  },
  pin: (threadId: string, pinned: boolean) =>
    post<{ pins: { thread_id: string; pinned_at: string }[] }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/pin`), { pinned }),
  /** Put the pins in this order (Move up, Move down): pins it does not name keep their place after them; a named thread not pinned now is skipped. */
  pinOrder: (order: readonly string[]) => post<{ pins: { thread_id: string; pinned_at: string }[] }>(inboxUrl('/pins'), { order }),
  /** Unpin's Undo: pin this one thread again at its old index, with the time it was first pinned. */
  pinRestore: (restore: { thread_id: string; index: number; pinned_at: string }) =>
    post<{ pins: { thread_id: string; pinned_at: string }[] }>(inboxUrl('/pins'), { restore }),
  /** Snooze the thread until a time, or end its snooze (`null`). `at`: an earlier snooze's own time, for an Undo. On the thread's own machine. */
  snooze: (threadId: string, until: string | null, at?: string) =>
    post<{ snoozed: { until: string; at: string } | null }>(threadUrl(threadId, '/snooze'), { until, ...(at ? { at } : {}) }),
  discardReplyDraft: (threadId: string) => post<{ ok: true; deleted: boolean }>(inboxUrl(`/threads/${encodeURIComponent(threadId)}/draft/delete`), {}),
  saveDraft: (id: string, input: { body: string; to: InboxDraft['to']; project: InboxDraft['project']; files: DraftFileInput[]; base: string | null; thread_name?: string; card?: InboxDraft['card']; pulls?: InboxDraft['pulls']; board_request?: true; start?: InboxDraft['start'] }) =>
    post<{ draft: DraftView }>(inboxUrl(`/drafts/${encodeURIComponent(id)}`), { ...input }),
  deleteDraft: (id: string) => post<{ ok: true; deleted: boolean }>(inboxUrl(`/drafts/${encodeURIComponent(id)}/delete`), {}),
  /** `timeoutMs`: given up after it (InboxReadTimeout), for a read a Send waits on. */
  sessions: (threadId: string, asker?: string | null, recipients: readonly string[] = [], timeoutMs?: number) => {
    const query = [
      ...(asker ? [`asker=${encodeURIComponent(asker)}`] : []),
      ...(recipients.length > 0 ? [`recipients=${recipients.map(encodeURIComponent).join(',')}`] : []),
    ].join('&');
    const url = threadUrl(threadId, `/sessions`, query);
    return timeoutMs === undefined ? get<LiveSessionsModel>(url) : getWithin<LiveSessionsModel>(url, timeoutMs);
  },
  /** Who the person can tag with `@` in this thread (approval "inbox-tag-agents"). */
  taggable: (threadId: string) => get<TaggableModel>(threadUrl(threadId, `/taggable`)),
  /**
   * Send now: deliver the person's reply or message at once, into the running turn when one runs.
   * `session`: one tagged session's own line (absent: the session the reply goes to).
   */
  sendNow: (messageId: string, session?: string | null) =>
    post<{ message: InboxMessage }>(messageUrl(messageId, `/send-now`), session ? { session } : {}),
  newMessage: (threadId: string, input: { session: string; body: string; idempotency_key: string }) =>
    post<{ message: InboxMessage | null; replayed: boolean; held?: OutboxView }>(threadUrl(threadId, `/message`), input).catch((cause) => {
      // To another machine: held in the outbox, as a reply is; the thread shows it waiting.
      if (cause instanceof InboxHeldError) return { message: null, replayed: false, held: cause.outbox };
      throw cause;
    }),
  // Phones: pairing, the paired devices, the tailnet and Wi-Fi switches (packages/server/inbox-devices.ts).
  // Linked machines (docs/agent-guides/inbox-machines.md). Linking and unlinking answer only on this computer.
  machines: () => get<{ self: string; machines: MachineView[] }>(inboxUrl('/machines')),
  /** This machine's one-time link code for another machine; `tailscale` publishes this Inbox's door on the tailnet first. */
  offerMachine: () => post<MachineOffer>(inboxUrl('/machines/offer'), { tailscale: true }),
  /** Link the machine whose code this is (a pasted link, or its address and six digits), both ways. */
  linkMachine: (input: { link: string } | { address: string; code: string }) => post<{ machine: MachineView }>(inboxUrl('/machines/link'), { ...input }),
  /** Read and start an update on a linked machine. Its body carries no version: that machine installs its own answer. */
  machineUpdate: (id: string) => get<MachineUpdateDetails>(inboxUrl(`/machines/${encodeURIComponent(id)}/update`)),
  startMachineUpdate: (id: string) => post<{ ok: true; outcome: string }>(inboxUrl(`/machines/${encodeURIComponent(id)}/update`), {}),
  /** An agent on that (older) machine was just asked to update it: its row says so, then Restarting and Updated. */
  machineUpdateAsked: (id: string, threadId: string | null, agent: string) =>
    post<{ ok: true; update: MachineUpdateView | null }>(inboxUrl(`/machines/${encodeURIComponent(id)}/update/asked`), { thread_id: threadId, agent }),
  unlinkMachine: (id: string) => post<{ unlinked: { id: string; name: string }; told: boolean }>(inboxUrl(`/machines/${encodeURIComponent(id)}/unlink`), {}),
  /** Writes held for other machines, and notices about ones that did not land. */
  outbox: () => get<{ waiting: OutboxView[]; notices: OutboxView[] }>(inboxUrl('/outbox')),
  dismissOutbox: (key: string) => post<{ entry: OutboxView }>(inboxUrl(`/outbox/${encodeURIComponent(key)}/dismiss`), {}),
  /** Take back a held write that never left (a launch waiting for a machine that is asleep): it is never sent. */
  cancelOutbox: (key: string) => post<{ entry: OutboxView }>(inboxUrl(`/outbox/${encodeURIComponent(key)}/cancel`), {}),
  pairPhone: () => post<PairingOffer>(inboxUrl('/pairing'), {}),
  pairingOffer: () => get<{ offer: PairingOfferView | null }>(inboxUrl('/pairing')),
  /** `fresh`: skip the answer the Inbox keeps a few seconds (Check again, after a switch). */
  pairingChecks: (fresh = false) => get<{ checks: PairingChecks; lan: LanState; tailnet: TailnetState }>(inboxUrl(`/pairing/checks${fresh ? '?fresh=1' : ''}`)),
  devices: () => get<{ devices: PairedDevice[] }>(inboxUrl('/devices')),
  removeDevice: (id: string) => post<{ device: PairedDevice }>(inboxUrl(`/devices/${encodeURIComponent(id)}/revoke`), {}),
  tailnet: () => get<{ tailnet: TailnetState }>(inboxUrl('/tailnet')),
  setTailnet: (on: boolean) => post<{ tailnet: TailnetState }>(inboxUrl('/tailnet'), { on }),
  lan: () => get<{ lan: LanState }>(inboxUrl('/lan')),
  setLan: (on: boolean) => post<{ lan: LanState }>(inboxUrl('/lan'), { on }),
  /** Settings → Accounts (packages/server/inbox-accounts.ts): this computer's Claude accounts, read through `cswap`. */
  /** `fresh`: skip the answer the Inbox keeps 30 s (Refresh). */
  accounts: (fresh = false) => get<InboxAccountsRead>(inboxUrl('/accounts', fresh ? 'fresh=1' : undefined)),
  /** Switch this computer's Claude Code account (step 3). The answer has no address; a read after it shows the account in use. */
  switchAccount: (target: InboxAccountSwitchTarget) => post<InboxAccountSwitch>(inboxUrl('/accounts/switch'), { ...target }),
  /** A linked machine's, through its door. One call per machine, so a slow one holds up only itself. */
  machineAccounts: (machine: string, fresh = false) => get<InboxMachineAccountsRead>(inboxUrl(`/accounts/${encodeURIComponent(machine)}`, fresh ? 'fresh=1' : undefined)),
  /** Settings → Agents and the agent-note dialog (packages/server/inbox-agents.ts, inbox-agent-notes.ts). */
  agents: () => get<InboxAgentsModel>(inboxUrl('/agents')),
  saveAgent: (agent: InboxAgentId, change: { reach?: boolean; reminder?: boolean; note?: boolean }) =>
    post<InboxAgentsModel>(inboxUrl('/agents'), { agent, ...change }),
  /** The note dialog's answer: `add` the ticked agents; `asked` the agents it showed (each asked once); `seen` its band showed the last run's news. */
  answerNotes: (add: InboxNoteAgentId[], asked: InboxNoteAgentId[], seen: boolean) =>
    post<InboxAgentsModel & { results: InboxNoteResult[] }>(inboxUrl('/agents/notes'), { add, asked, seen }),
  /** The connect line showed: the report it said (`at`, null for none) and the notes written by themselves it listed; only those are marked said. */
  agentsSeen: (reportAt: string | null, notes: readonly InboxNoteAutoAdd[]) =>
    post<InboxAgentsModel>(inboxUrl('/agents/seen'), { report_at: reportAt, notes: notes.map(({ agent, path }) => ({ agent, path })) }),
  /** Ask AI (packages/server/inbox-ask.ts): the chat list, one thread's chat, a question, and what the window saw. */
  askChats: () => get<{ chats: InboxAskChat[] }>(inboxUrl('/ask')),
  askRead: (threadId: string) => get<InboxAskModel>(inboxUrl(`/threads/${threadId}/ask`)),
  askSend: (threadId: string, turnId: string, question: string, showMe?: InboxShowMeAsk, source?: string) =>
    post<InboxAskPosted>(inboxUrl(`/threads/${threadId}/ask`), { turn_id: turnId, question, ...(showMe ?? {}), ...(source ? { source } : {}) }),
  askSeen: (threadId: string, seenAt: string) => post<unknown>(inboxUrl(`/threads/${threadId}/ask/seen`), { seen_at: seenAt }),
  askStop: (threadId: string, turnId: string) => post<{ stopped: boolean }>(inboxUrl(`/threads/${threadId}/ask/stop`), { turn_id: turnId }),
  deleteProject: (projectId: string) => post<{ store: InboxStorageModel }>(inboxUrl(`/projects/${encodeURIComponent(projectId)}/delete`), {}),
};

/** One question and what came of it (`packages/shared/inbox/ask.ts`). */
export interface InboxAskTurnWire {
  id: string;
  at: string;
  session: string;
  host: string | null;
  question: string;
  passage?: string;
  /** Where a Side's quoted words came from: what the agent gets in front of `question`. */
  source?: string;
  answer?: string;
  answered_at?: string;
  stopped?: boolean;
  failure?: 'gone' | 'taken_over' | 'failed';
  /** A Show me (code review in the Inbox): the agent was asked for a Shape of these lines of a review. */
  kind?: 'show_me';
  show_me?: InboxShowMeTarget;
  /** Show me again: the board it asked to bring up to date. */
  again_shape?: string;
  /** The board this Show me made, once it has one. */
  shape?: string;
}

/** What a Show me sends beside its question on `POST …/ask`. */
export interface InboxShowMeAsk {
  kind: 'show_me';
  show_me: InboxShowMeTarget;
  again_shape?: string;
}

export interface InboxAskConversationWire {
  v: 1;
  thread_id: string;
  seen_at: string | null;
  turns: InboxAskTurnWire[];
}

/** `GET /api/inbox/threads/:id/ask`. */
export interface InboxAskModel {
  subject: string | null;
  project: string;
  conversation: InboxAskConversationWire | null;
  /** The file doesn't parse, so `conversation` is null: the next question sets it aside. */
  damaged?: true;
  /** The turn being answered, or null. */
  running: string | null;
  /** The icons show: an open thread whose owner's connection can answer now. */
  can_ask: boolean;
  agent: { host: string | null; name: string };
}

/** `POST /api/inbox/threads/:id/ask`. */
export interface InboxAskPosted {
  conversation: InboxAskConversationWire;
  turn: InboxAskTurnWire;
  /** What `/api/ai/session` must name for this turn; null when nothing can run now. */
  provider_id: string | null;
  reason?: 'no_connection' | 'no_live_path';
  /** The turn is already being answered, in another window. */
  running?: boolean;
}

/** One row of the chat list (`GET /api/inbox/ask`). */
export interface InboxAskChat {
  thread_id: string;
  subject: string | null;
  project: string;
  host: string | null;
  /** When anything last happened in the chat. */
  at: string;
  unread: boolean;
  answering: boolean;
}

/** One note the dialog asked to add: written, or why not. */
export type InboxNoteResult = { ok: true; agent: InboxNoteAgentId; action: string; path: string | null } | { ok: false; agent: InboxNoteAgentId; reason: string; path: string | null };

/** One store line as the event stream carries it (packages/server/inbox.ts, `eventPayload`). */
export type InboxEvent =
  | { seq: number; kind: 'project'; id: string; project: InboxProject }
  /** `first`: the message's first line, not a later rewrite of it (a look, an archive, an Unarchive). Absent from an older Inbox. */
  | { seq: number; kind: 'message'; id: string; first?: boolean; message: InboxMessage }
  /** `thread_id`: its message's thread (null when that message is gone); absent from an older Inbox. */
  | { seq: number; kind: 'question'; id: string; thread_id?: string | null; question: InboxQuestion }
  | { seq: number; kind: 'annotation'; id: string; annotation: InboxAnnotationRecord }
  /** A Board card (approval "inbox-board"); absent from an older Inbox. */
  | { seq: number; kind: 'card'; id: string; card: InboxCardWire }
  /** A session's steps in a thread changed (approval "inbox-thread-steps"): silent; the window reads that thread's steps again. Absent from an older Inbox. */
  | { seq: number; kind: 'steps'; id: string; thread_id: string }
  /** A Board initiative made, renamed or deleted (approval "board-initiatives"): silent; the Board reads its cards again. Absent from an older Inbox. */
  | { seq: number; kind: 'initiative'; id: string; initiative: InboxInitiative }
  /** A thread's PRs changed (approval "inbox-pr-binding"): silent; the window reads that thread's PRs and the list again. Absent from an older Inbox. */
  | { seq: number; kind: 'thread_pull'; id: string; thread_id: string };

/** A thread's attachments as they are now, and the person's annotations waiting for a Send. */
export interface AttachmentsModel {
  serverSession: string;
  attachments: InboxAttachmentState[];
  /** The images the messages show, captured as files (additive; absent from an older Inbox). */
  inline_images?: InboxAttachmentState[];
  annotations: InboxAnnotationRecord[];
  /** The person's comments on files that a Send already carried (additive; absent from an older Inbox or peer). */
  earlier_annotations?: InboxAnnotationRecord[];
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

/** A sibling document, as `/linked-page` answers it. */
interface LinkedPageBase {
  serverSession: string;
  /** Its realpath. */
  path: string;
  name: string;
  /** Its asset-route URL, for Open in new tab. */
  url: string | null;
}

export type LinkedPageView = LinkedPageBase & ({ html: string } | { html: null; text: string });

/** What `subscribeInboxEvents` calls (the server's frames, read). */
export interface InboxEventHandlers {
  onRecord: (event: InboxEvent | null) => void;
  /**
   * `updated` is undefined from an Inbox older than the field (the "What's new in X" link stays as the list said);
   * `restartClaudeCode` too (the sidebar's "Reload Claude Code N" stays as the list said), and
   * `restartAgents` (every runtime's count, "Reload agents N").
   */
  onStatus: (update: InboxHealth['update'], updated?: string | null, restartClaudeCode?: number, restartAgents?: InboxRestartAgents, checkFailing?: UpdateCheckFailing | null) => void;
  /** Whether a notification can reach the person now (inbox-windows.ts); never called by an older Inbox. */
  onReach?: (reach: InboxNotifyReach) => void;
  /**
   * A row's delivery may have moved with the live sessions (a turn started or
   * ended, a session went away): no store line, so the list is read again.
   * Never called by an older Inbox. `sessions`: a session ended or came back, so a row's "Session ended" may have
   * moved. `labels`: a session's label changed too (issue #2450), so the rows' agents
   * and the authors read the list again.
   */
  onDeliveries?: (change?: { labels: boolean; sessions: boolean; agents?: boolean }) => void;
  /**
   * The stream (re)connected: the server's `hello`. A reconnect carries the
   * URL it was first opened with, so its `permission=` may be stale (a grant
   * since, a restarted Inbox that forgot the window): report again here.
   * With a shared stream (sharedEvents.ts) also called when the tab whose
   * stream serves this one changes, so the report names it (`served_by`).
   */
  onConnect?: (hello?: RestartHello) => void;
  /**
   * A reply draft was saved or discarded (`event: drafts`, approval "inbox-reply-drafts"), or a compose draft saved,
   * deleted or sent (`{ compose: true }`: null); never called by an older Inbox.
   */
  onDrafts?: (threadId: string | null) => void;
  /** An Ask AI chat changed (`event: ask`), only ever on the owner's own window. */
  onAsk?: (threadId: string) => void;
  /** The sidebar's pins changed (`event: pins`, approval "inbox-pinned-threads"); never called by an older Inbox. */
  onPins?: () => void;
  /** The pinned artifacts changed (`event: artifact-pins`, approval "inbox-artifact-stars"); never called by an older Inbox. */
  onArtifactPins?: () => void;
  /** A snooze changed or ran out (`event: snoozes`, approval "inbox-snooze"), here or on a linked machine; never called by an older Inbox. */
  onSnoozes?: () => void;
  /** A read of these threads' PRs changed their checks or review (`event: thread-pulls`, no record); never called by an older Inbox. */
  onThreadPulls?: (threadIds: string[]) => void;
  /** How the list's rows look was saved, here or in another window (`event: rows`, approval "inbox-customize-rows"). */
  /** `last`: the look before this save and, for an agent's command, who made it (`prev`, `by`; absent from an older Inbox). */
  onRows?: (rows: unknown, rev: unknown, last: { prev: unknown; by: unknown }) => void;
  /** The sidebar's layout was saved, here or in another window (`event: sidebar`, approval "inbox-sidebar-customize"). */
  onSidebar?: (sidebar: unknown, rev: unknown) => void;
  /** An agent icon's face was saved (`{ faces, rev }`, unparsed). */
  onAgentFaces?: (data: unknown) => void;
  /** The tray's saved emoji changed, here or in another window (`event: reactions`, approval "inbox-reaction-tray"). */
  onReactions?: (reactions: unknown, rev: unknown) => void;
  /** A capability switch was saved, here or in another window (`event: capabilities`: the Board, thread steps, ...); never called by an older Inbox. */
  onCapabilities?: (capabilities: { board?: { on: boolean }; steps?: { on: boolean }; bro?: { on: boolean }; float_drafts?: { on: boolean }; mark_read_warning?: { on: boolean }; code_review?: { on: boolean }; shape?: { on: boolean }; system?: { on: boolean }; chapter_diagrams?: { on: boolean } }) => void;
  /** Shape's boards changed (`event: shapes`, only while Shape is on): their ids. */
  onShapes?: (ids: string[]) => void;
  /**
   * Linked machines (`machines=1`): a record from another machine's own stream, with that machine's own seq
   * (never this Inbox's). `live: false` is a resync after a reconnect: never a notification.
   */
  onMachine?: (frame: MachineRecordFrame) => void;
  /** Every machine and its state: a snapshot when the stream opens, and on every change (a state, a far list read again). */
  onMachines?: (machines: MachineView[]) => void;
  /** A write held for another machine changed state (queued, sending, delivered, refused…). */
  onOutbox?: (entry: OutboxView) => void;
  /**
   * The live stream went silent past its window (liveStream.ts), or the tab came back after it: read the list and
   * the open thread again, so nothing it missed stays missed. Never called while the stream is heard.
   */
  onCatchUp?: () => void;
  /** The live stream is dead (`false`: a reconnect brought nothing) or heard again (`true`). Called on a change only. */
  onLive?: (live: boolean) => void;
}

/** The `machine` frame: one record of another machine's event stream. */
export interface MachineRecordFrame {
  machine: string;
  seq: number;
  live: boolean;
  record: InboxEvent | null;
}

/** This window, as its event stream (or its report) names it to the server (inbox-windows.ts). */
export interface InboxEventWindow {
  id: string;
  permission: InboxWindowPermission;
  origin: string;
}

/** The event stream's named frames, as they arrive (and as the tab that holds the shared stream passes them on). */
// `heartbeat`: a window's stream beats every 10 s (packages/server/inbox.ts); heard by liveStream.ts, handled by nothing.
export const INBOX_EVENT_FRAMES = ['hello', 'record', 'status', 'reach', 'deliveries', 'drafts', 'ask', 'pins', 'artifact-pins', 'snoozes', 'thread-pulls', 'rows', 'sidebar', 'agent-faces', 'reactions', 'capabilities', 'shapes', 'machine', 'machines', 'outbox', 'heartbeat'] as const;
export type InboxEventFrameName = (typeof INBOX_EVENT_FRAMES)[number];
export interface InboxEventFrame {
  name: InboxEventFrameName;
  /** The frame's `data`, unparsed. */
  data: string;
  /** The frame's `id` (a record's seq), or null. */
  id: string | null;
}

/**
 * Open the server's event stream for this tab: every named frame, unparsed,
 * after `cursor`. EventSource reconnects on its own and resumes from the last
 * event id. Answers the close.
 */
export function openInboxEventFrames(cursor: number, onFrame: (frame: InboxEventFrame) => void, win?: InboxEventWindow): () => void {
  // `machines=1`: other machines' records and states ride this one stream in frames of their own (never this
  // Inbox's seq). An older Inbox ignores it; with nothing linked only the `machines` snapshot comes.
  const query = new URLSearchParams({ cursor: String(cursor), machines: '1' });
  if (win) {
    query.set('window', win.id);
    query.set('permission', win.permission);
    query.set('origin', win.origin);
  }
  const source = new EventSource(inboxUrl(`/events?${query}`));
  for (const name of INBOX_EVENT_FRAMES) {
    source.addEventListener(name, (event) => {
      const message = event as MessageEvent<string>;
      onFrame({ name, data: typeof message.data === 'string' ? message.data : '', id: message.lastEventId || null });
    });
  }
  return () => source.close();
}

/** One frame to the handlers: what each named event means. */
export function dispatchInboxFrame(frame: InboxEventFrame, handlers: InboxEventHandlers): void {
  switch (frame.name) {
    case 'heartbeat':
      // Only proof the stream is alive: no read, nothing to show.
      return;
    case 'hello':
      // The run that answers and its cursor: a page that lived through a restart reads them (sessionAdopt.ts).
      handlers.onConnect?.(readHello(frame.data) ?? undefined);
      return;
    case 'reach':
      try {
        handlers.onReach?.(JSON.parse(frame.data) as InboxNotifyReach);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'drafts':
      try {
        const data = JSON.parse(frame.data) as { thread_id?: unknown; compose?: unknown };
        if (typeof data.thread_id === 'string') handlers.onDrafts?.(data.thread_id);
        else if (data.compose === true) handlers.onDrafts?.(null);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'ask':
      try {
        const data = JSON.parse(frame.data) as { thread_id?: unknown };
        if (typeof data.thread_id === 'string') handlers.onAsk?.(data.thread_id);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'deliveries': {
      let labels = false;
      let sessions = false;
      let agents = false;
      try {
        const change = JSON.parse(frame.data) as { labels?: unknown; sessions?: unknown; agents?: unknown } | null;
        labels = change?.labels === true;
        sessions = change?.sessions === true;
        // The sidebar's Agents moved (agentsList.ts).
        agents = change?.agents === true;
      } catch {
        // An empty or malformed frame is a delivery change alone.
      }
      handlers.onDeliveries?.({ labels, sessions, agents });
      return;
    }
    case 'pins':
      handlers.onPins?.();
      return;
    case 'artifact-pins':
      handlers.onArtifactPins?.();
      return;
    case 'snoozes':
      handlers.onSnoozes?.();
      return;
    case 'thread-pulls':
      try {
        const data = JSON.parse(frame.data) as { thread_ids?: unknown };
        const ids = Array.isArray(data.thread_ids) ? data.thread_ids.filter((id): id is string => typeof id === 'string') : [];
        if (ids.length > 0) handlers.onThreadPulls?.(ids);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'rows':
      try {
        const data = JSON.parse(frame.data) as { rows?: unknown; rev?: unknown; prev?: unknown; by?: unknown };
        handlers.onRows?.(data.rows, data.rev, { prev: data.prev, by: data.by });
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'sidebar':
      try {
        const data = JSON.parse(frame.data) as { sidebar?: unknown; rev?: unknown };
        handlers.onSidebar?.(data.sidebar, data.rev);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'agent-faces':
      try {
        handlers.onAgentFaces?.(JSON.parse(frame.data));
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'reactions':
      try {
        const data = JSON.parse(frame.data) as { reactions?: unknown; rev?: unknown };
        handlers.onReactions?.(data.reactions, data.rev);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'capabilities':
      try {
        const data = JSON.parse(frame.data) as { board?: { on?: unknown }; steps?: { on?: unknown }; bro?: { on?: unknown }; float_drafts?: { on?: unknown }; mark_read_warning?: { on?: unknown }; code_review?: { on?: unknown }; shape?: { on?: unknown }; system?: { on?: unknown }; chapter_diagrams?: { on?: unknown } };
        handlers.onCapabilities?.({
          ...(typeof data.board?.on === 'boolean' ? { board: { on: data.board.on } } : {}),
          ...(typeof data.steps?.on === 'boolean' ? { steps: { on: data.steps.on } } : {}),
          ...(typeof data.bro?.on === 'boolean' ? { bro: { on: data.bro.on } } : {}),
          ...(typeof data.float_drafts?.on === 'boolean' ? { float_drafts: { on: data.float_drafts.on } } : {}),
          ...(typeof data.mark_read_warning?.on === 'boolean' ? { mark_read_warning: { on: data.mark_read_warning.on } } : {}),
          ...(typeof data.code_review?.on === 'boolean' ? { code_review: { on: data.code_review.on } } : {}),
          ...(typeof data.shape?.on === 'boolean' ? { shape: { on: data.shape.on } } : {}),
          ...(typeof data.system?.on === 'boolean' ? { system: { on: data.system.on } } : {}),
          ...(typeof data.chapter_diagrams?.on === 'boolean' ? { chapter_diagrams: { on: data.chapter_diagrams.on } } : {}),
        });
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'shapes':
      try {
        const data = JSON.parse(frame.data) as { ids?: unknown };
        if (Array.isArray(data.ids)) handlers.onShapes?.(data.ids.filter((id): id is string => typeof id === 'string'));
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'machine':
      try {
        const data = JSON.parse(frame.data) as Partial<MachineRecordFrame>;
        if (typeof data.machine === 'string' && typeof data.seq === 'number') {
          // A linked machine's steps line (approval "inbox-thread-steps"): its threads show no steps here, so it
          // neither rings nor makes the open thread read again.
          // A linked machine's thread PRs line (approval "inbox-pr-binding"): the same, its threads show none here.
          const machineKind = (data.record as { kind?: unknown } | undefined)?.kind;
          if (machineKind === 'steps' || machineKind === 'thread_pull') return;
          rememberMachine(idsIn(data.record), data.machine);
          handlers.onMachine?.({ machine: data.machine, seq: data.seq, live: data.live === true, record: (data.record as InboxEvent | undefined) ?? null });
        }
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'machines':
      try {
        const data = JSON.parse(frame.data) as { machines?: unknown };
        if (Array.isArray(data.machines)) handlers.onMachines?.(data.machines as MachineView[]);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'outbox':
      try {
        const data = JSON.parse(frame.data) as OutboxView;
        if (typeof data.key === 'string' && typeof data.machine === 'string') handlers.onOutbox?.(data);
      } catch {
        // A malformed frame changes nothing.
      }
      return;
    case 'record': {
      let parsed: InboxEvent | null = null;
      try {
        parsed = JSON.parse(frame.data) as InboxEvent;
      } catch {
        // A malformed frame still refreshes the list.
      }
      // This Inbox's own record: every id in it is local for good (another machine's arrive as `machine` frames).
      if (parsed) rememberLocal(localIdsIn(parsed));
      handlers.onRecord(parsed);
      return;
    }
    case 'status':
      try {
        const data = JSON.parse(frame.data) as {
          update: InboxHealth['update'];
          updated?: string | null;
          restart_claude_code?: unknown;
          restart_agents?: unknown;
          update_check_failing?: UpdateCheckFailing | null;
        };
        handlers.onStatus(
          data.update,
          'updated' in data ? (data.updated ?? null) : undefined,
          typeof data.restart_claude_code === 'number' ? data.restart_claude_code : undefined,
          parseRestartAgents(data.restart_agents) ?? undefined,
          'update_check_failing' in data ? (data.update_check_failing ?? null) : undefined,
        );
      } catch {
        // A malformed frame changes nothing.
      }
      return;
  }
}

/**
 * The server's event stream: `onRecord` for every store line after the
 * cursor (the line, for the notifications), `onStatus` for restart-to-update.
 *
 * The Inbox tabs of one origin share ONE stream (sharedEvents.ts): the tab
 * holding a Web Lock opens it and passes every frame on over a
 * BroadcastChannel, so a browser never holds one HTTP/1.1 connection per tab
 * (Chrome allows six per host; a seventh tab would stall). Where Web Locks or
 * BroadcastChannel is missing, or there is no window to name, this tab opens
 * its own stream exactly as before.
 */
export function subscribeInboxEvents(
  cursor: number,
  handlers: InboxEventHandlers,
  /** This window, so the server counts it (and what its browser allows) while the stream is open. */
  win?: InboxEventWindow,
): () => void {
  if (win && sharedInboxEventsSupported()) {
    return subscribeSharedInboxEvents(cursor, handlers, win, browserSharedEventsEnv({ open: openInboxEventFrames, dispatch: dispatchInboxFrame }));
  }
  // A window's own stream beats too: the same silence watch, reopening this tab's stream.
  if (win && typeof document !== 'undefined') {
    return subscribeOwnInboxEvents(cursor, handlers, win, {
      open: openInboxEventFrames,
      dispatch: dispatchInboxFrame,
      lifecycle: { document, window },
      isVisible: () => document.visibilityState === 'visible',
    });
  }
  return openInboxEventFrames(cursor, (frame) => dispatchInboxFrame(frame, handlers), win);
}

// ───────────────────────────── Shape ─────────────────────────────

/** One board in the list (packages/shared/shape/store.ts `ShapeSummary`), with its latest Picture for the grid. */
export interface InboxShapeSummary {
  id: string;
  title: string;
  project: { name: string; root: string };
  thread: string | null;
  state: 'active' | 'finished';
  updated: string;
  latest: number;
  seen: number | null;
  changed: boolean;
  drawing: boolean;
  waiting: number;
  session: { host: string; id: string } | null;
  preview?: { picture: ShapeDrawnView | null; refs: ShapeRef[] } | null;
}

/** `GET /api/shapes/:id`. */
export interface ShapeLoadedWire {
  shape: ShapeRecord;
  version: ShapeVersion;
  seen: number | null;
  notes: ShapeNote[];
  session: { state: 'live' | 'busy' | 'gone'; agent: string };
}

