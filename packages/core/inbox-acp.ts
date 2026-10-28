/**
 * Plannotator Inbox: sessions the Inbox runs itself over ACP (spec "Inbox
 * replies as real turns for Cursor and Grok", step 1: Grok Build). The wire
 * shapes the server's runner (packages/server/inbox-acp-runner.ts) answers and
 * the window draws (the run line, the permission card, compose's "New
 * Grok Build session"). Browser-safe: no Node.
 *
 * Nothing here ever carries an agent's raw ACP traffic: activity is tool
 * titles and the agent's own text, kept in memory only.
 */

/** The agents the runner can start. Cursor is one more entry once its check reports. */
export type InboxRunAgentId = "grok";

/** What the person sees an agent called. */
export const INBOX_RUN_AGENT_LABELS: Readonly<Record<InboxRunAgentId, string>> = { grok: "Grok Build" };

/** A runner session's agent session id: `run_` + a ULID (core `isInboxId("run", …)`). */
export const INBOX_RUN_SESSION_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isInboxRunHost(host: unknown): host is InboxRunAgentId {
  return host === "grok";
}

/** How one turn ended. `interrupted`: the Inbox stopped (or restarted) while it ran; the reply is not sent again. */
export type InboxRunOutcome = "done" | "stopped" | "failed" | "interrupted";

/** One turn: the person's messages it carried, and how it ended. */
export interface InboxRunTurn {
  /** The person's replies (or the thread's first message) this turn delivered, oldest first. */
  replies: string[];
  started_at: string;
  ended_at: string | null;
  outcome: InboxRunOutcome | null;
  /** Why it failed, in plain words (never the agent's stderr). */
  error: string | null;
  /**
   * How the agent answered: `inbox` (it sent a message itself), `final_text`
   * (it did not, so the runner posted its turn's final text), `none` (no text
   * either). Null while it runs.
   */
  answered: "inbox" | "final_text" | "none" | null;
}

/** One option of a permission request, as the agent offered it. */
export interface InboxRunPermissionOption {
  id: string;
  name: string;
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  kind: string;
}

/** A permission request waiting on the person. No timeout: it waits until answered or Stopped. */
export interface InboxRunPermission {
  id: string;
  /** The agent's own title for the tool call ("Run `rm -rf build`"). */
  title: string;
  kind: string | null;
  options: InboxRunPermissionOption[];
  at: string;
}

/** A tool the agent ran this turn: its title and status. */
export interface InboxRunTool {
  id: string;
  title: string;
  status: string;
}

export type InboxRunState = "idle" | "starting" | "working" | "permission";

/** `GET /api/inbox/acp/:key`. */
export interface InboxRunStatus {
  key: string;
  agent: InboxRunAgentId;
  label: string;
  /** Where the agent works (the project's folder). */
  cwd: string;
  /** The same, with the home folder as `~`. */
  cwd_display: string;
  /** The agent's own session id, once it made one. */
  acp_session_id: string | null;
  /** The thread the person started it in. */
  thread_id: string | null;
  state: InboxRunState;
  /** The turn running now, else the last one. */
  turn: InboxRunTurn | null;
  /** The last turns, oldest first (at most 50). */
  turns: InboxRunTurn[];
  /** The request waiting on the person, or null. */
  permission: InboxRunPermission | null;
  /** This turn's (or the last turn's) last tools and text, from memory: empty after an Inbox restart. */
  activity: { tools: InboxRunTool[]; text: string };
  /** The person's messages waiting for the next turn (not delivered yet). */
  queued: string[];
  /** The command that opens this session in the agent's own CLI (`cd <folder> && grok -r <id>`), or null. */
  resume_command: string | null;
  /** The same, in two parts for the foot: the agent's command (`grok -r <id>`) and the folder it runs in (`~/billing`). */
  resume: { command: string; folder: string } | null;
  /** "Approve the rest of this turn" is on. */
  approve_rest: boolean;
}

/** An agent the runner can start, for compose and Settings. */
export interface InboxRunAgentInfo {
  id: InboxRunAgentId;
  label: string;
  /** Installed and answering like itself. */
  installed: boolean;
  /** Why it cannot start, when it cannot (not installed, turned off). */
  reason: string | null;
  /** Settings → Agents' "Run in the Inbox" (default on). */
  enabled: boolean;
  /** How to install it. */
  install_command: string;
  /** It updates itself when it starts (Grok Build does). */
  self_updates: boolean;
}

/** A folder compose can start a session in: the Inbox's projects whose folder exists, most recently active first. */
export interface InboxRunPlace {
  project_id: string;
  name: string;
  root: string;
  root_display: string;
}

/** `GET /api/inbox/acp`. */
export interface InboxRunAgentsModel {
  agents: InboxRunAgentInfo[];
  places: InboxRunPlace[];
}

/** A list row's run (additive on `InboxListRow`): the agent works, or waits on a permission. */
export interface InboxRowRun {
  key: string;
  agent: InboxRunAgentId;
  label: string;
  state: InboxRunState;
  /** The permission's tool title, while one waits. */
  permission_title: string | null;
  permission_id: string | null;
}

/** The run line's words for a turn that ended (the window and the phone say the same). */
export function inboxRunOutcomeWords(turn: Pick<InboxRunTurn, "outcome" | "error" | "started_at" | "ended_at" | "answered">, label: string): string {
  const took = turn.ended_at ? ` · ${inboxRunDuration(Date.parse(turn.ended_at) - Date.parse(turn.started_at))}` : "";
  switch (turn.outcome) {
    case "done":
      return turn.answered === "none" ? `Done${took} · ${label} wrote no answer` : `Done${took}`;
    case "stopped":
      return `Stopped${took}`;
    case "interrupted":
      return "Interrupted: the Inbox stopped while it ran. Your message is not sent again.";
    case "failed":
      return `Not sent: ${turn.error ?? `${label} could not run this.`}`;
    default:
      return "";
  }
}

/** `0:42`, `1:12`, `1:02:05`. */
export function inboxRunDuration(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
