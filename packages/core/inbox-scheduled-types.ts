/**
 * Routines: a saved prompt with a name, a schedule, a folder and an on/off switch, whose runs all land in
 * one Inbox thread. The records and the wire shapes the window reads; the routes are in
 * docs/agent-guides/inbox-routines.md. Browser-safe: types only.
 */

/** A cron with its time zone, a one-time date and time with its zone, or null: it runs only when someone runs it. */
export type InboxScheduledSchedule = { cron: string; tz: string } | { at: string; tz: string } | null;

export type InboxScheduledIfMissed = "run_once" | "skip";

/**
 * Where its runs work: a project's folder, a folder by its real path (a worktree or a subfolder runs there, not at its
 * project's root; home, `/` and hidden folders are refused as New message refuses them), or a new scratch folder made
 * at its first run (then that project).
 */
export type InboxScheduledFolder = { project_id: string } | { path: string } | { scratch: true };

/** The record, kind `scheduled`, in `<dataDir>/inbox/scheduled.jsonl` (one file for every project, like initiatives). */
export interface InboxScheduledThread {
  /** `sch_…` */
  id: string;
  name: string;
  enabled: boolean;
  /**
   * When the person last turned it on in the window. Null until then, and again after an agent changed its folder or its agent.
   * Agents may turn it on and run it only while this is set.
   */
  approved_at: string | null;
  prompt: string;
  schedule: InboxScheduledSchedule;
  if_missed: InboxScheduledIfMissed;
  runs_on: "this_computer";
  folder: InboxScheduledFolder;
  /** The launch agent id: `claude-code`, `pi`, `codex`, `opencode`. */
  agent: string;
  model?: string;
  effort?: string;
  /** Files on this computer the prompt names (absolute paths): each run's divider carries them, as send_message's do. */
  attachments: string[];
  /** The thread its runs land in: made at the first run or skip line. Null again after the person deletes it. */
  thread_id: string | null;
  /** The runs counted in threads the person deleted: the next run's number counts on from it. */
  runs_before?: number;
  /** The window's `idempotency_key` it was made with: a create sent again with it (a retry, a reloaded or restored tab, after a restart) answers this one. Never on the wire. */
  create_key?: string;
  /** The agent session that made it, and the thread it asked from. */
  made_by?: { host: string; session: string; thread_id: string };
  /**
   * Where the clock counts from (ISO): set when it is turned on or its schedule changes. A run or skip line the clock
   * writes counts too (its `due_at`), so this record is not written again at every due time.
   */
  handled_through: string | null;
  /** A one-time schedule after its run (or its skip): Done. */
  done_at?: string;
  /** Delete: the last line, and nothing reads it after. Its thread and past runs stay. */
  deleted_at?: string;
  created_at: string;
  updated_at: string;
}

export type InboxScheduledSkipReason = "asleep" | "not_running" | "still_running" | "missed" | "late";

/**
 * On a message: the run divider ("Run 4"), which carries the prompt to the run's session as its first turn, or a
 * skip line (`skipped`, no `run`), which goes to nobody. Both are written by the Inbox, authored as the person (the
 * prompt is theirs) and drawn as a line, never as "You".
 */
export interface InboxScheduledRun {
  scheduled_id: string;
  /** The routine's name when this was written (the Inbox row's sender). */
  name: string;
  /** 1, 2, 3…: absent on a skip line. */
  run?: number;
  /** The due time it ran for; for Run now, the time it was pressed. */
  due_at: string;
  /** Who started it: the clock, or Run now from the window or an agent. */
  by: "schedule" | "person" | "agent";
  /** Started more than 2 minutes after `due_at`. */
  late?: true;
  /** Earlier due times folded into this late run (counted up to 1,000). */
  missed_before?: number;
  /** On a skip line: the due times skipped (counted up to 1,000), and why. */
  skipped?: { count: number; from: string; to: string; reason: InboxScheduledSkipReason };
  /** A run that didn't start (the agent missing, the folder gone): why, in the launch's own words. */
  failed?: string;
}

/**
 * On a change message an agent's `routine` call posts in the thread it called from ("Made the scheduled
 * thread X…", "Changed…"): the editor link. The body names what changed, old and new.
 */
export interface InboxScheduledChange {
  scheduled_id: string;
  name: string;
  op: "create" | "update" | "on" | "off" | "run" | "delete";
  /** The fields that changed, for an update. */
  fields?: ("name" | "prompt" | "schedule" | "folder" | "if_missed" | "agent" | "model" | "effort" | "attachments")[];
  /** A folder or agent change turned it off until the person turns it on again. */
  turned_off?: true;
}

/** How the last run ended, computed on read from its divider, the session's messages after it and its run line. */
export type InboxScheduledOutcome = "running" | "replied" | "didnt_finish" | "didnt_start";

export interface InboxScheduledRunSummary {
  /** The divider's message id (a click opens the thread there). */
  message_id: string;
  run: number;
  due_at: string;
  started_at: string;
  late: boolean;
  outcome: InboxScheduledOutcome;
}

/** `on` and enabled, `off`, `running` (a run is under way), `done` (a one-time one after its time). */
export type InboxScheduledState = "on" | "off" | "running" | "done";

/** A row of `GET /api/inbox/scheduled`, and `GET /api/inbox/scheduled/:id`'s `scheduled`. */
export interface InboxScheduledRow extends InboxScheduledThread {
  state: InboxScheduledState;
  /** "Every weekday at 9:00 AM", "Once on Fri, Nov 20 at 5:00 PM", "Every 2 hours, at minute 0", "Runs when you run it." */
  schedule_words: string;
  /** The zone's short name now ("EST"), or null with no schedule. */
  tz_short: string | null;
  /** The next due time (ISO), or null: off, done, no schedule. */
  next_run: string | null;
  runs: number;
  last_run: InboxScheduledRunSummary | null;
  /** While a run is under way: when it started (ISO). */
  running_since: string | null;
  /** The folder as the person reads it (`~/code/acme-api`), or "New scratch folder" before a scratch one's first run. */
  folder_shown: string;
  /** The project's name, or null for a scratch one before its first run. */
  project_name: string | null;
  /** The name of the thread its runs land in ("Replies in"), or null before its first run. */
  thread_name: string | null;
  /** The newest change line an agent wrote in its own thread: which change, by whom, when (the list row reads it while it is the latest). */
  last_change: { op: InboxScheduledChange["op"]; by: string; at: string } | null;
}

/** `POST /api/inbox/scheduled/preview`: a schedule being edited, before it is saved. */
export interface InboxScheduledPreview {
  ok: boolean;
  schedule_words: string;
  tz_short: string | null;
  next_run: string | null;
  /** Present when it is refused: the plain line, and how often it would run. */
  refused?: { code: "schedule_too_frequent" | "schedule_invalid"; error: string; every_minutes?: number };
}
