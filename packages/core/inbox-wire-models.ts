/**
 * The envelopes the Inbox's reads answer with (the list, a thread, Archived, a
 * reply) and the small views inside them, as the window and the native app's
 * contract (apps/mobile/contract, scripts/mobile/schema.ts) both read them.
 * Types only. packages/inbox/api.ts re-exports them for the window.
 */
import type {
  InboxAgentsGroup,
  InboxHealth,
  InboxInitiative,
  InboxListRow,
  InboxListSection,
  InboxProject,
  InboxQuestion,
  InboxRestartAgents,
  InboxRun,
  InboxTagColours,
  InboxTagLook,
  InboxThread,
} from "./inbox-types";

/** The list model's tags (ListModel extends this). */
export interface ListTagsFields {
  /**
   * The live tags, oldest first (approval "inbox-thread-tags"): the sidebar's Tags and the Add tag list; each row's
   * `tags` names them. Absent from an older Inbox: the window then draws no Tags section and offers no Add tag.
   * Merged: one per name across the linked machines that take tags, `machines` its id on each (InboxMachineTag).
   */
  tags?: (InboxInitiative & { machines?: Record<string, string>; look?: InboxTagLook })[];
  /** "Show tag colors" and the person's own colours. Absent from an Inbox before tag colours. */
  tag_colours?: InboxTagColours;
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
  /** Its git origin's host (null: none named, links as github.com); absent with no repo and from an older Inbox. */
  repo_host?: string | null;
  repo_forge?: 'gitlab';
  /**
   * The live tags the person put on the project (project-tags.ts; merged: the merged tags' ids), read by the filters
   * only. Absent when none, and from an older Inbox.
   */
  tags?: string[];
}

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
  /** The marks it takes for its own threads and agents (approval "inbox-linked-marks"; `machineTakes`). Absent from an older Inbox. */
  marks?: string[];
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

/** Checking for updates has failed for hours with no success (packages/shared/update-check.ts releaseCheckFailing). */
export interface UpdateCheckFailing {
  since: string;
  error: string;
}

export interface ListModel extends ListTagsFields {
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
   * an older Inbox, which then reads every session as before.
   */
  session_labels?: Record<string, string>;
  session_titles?: Record<string, string>;
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
  /** `machines=1`: each linked machine asked, `away` when its rows are the ones it last gave. */
  machines?: Record<string, { away: boolean }>;
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
  /** Asked with `with_thread`: the thread as a read of it answers now (the sent reply in it). Absent from an older Inbox. */
  thread_read?: ThreadModel;
  /** To another machine: held in this Inbox's outbox until that machine's Inbox answers (the thread shows it waiting). */
  held?: OutboxView;
}
