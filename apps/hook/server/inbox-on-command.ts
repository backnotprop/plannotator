/**
 * The CLI's side of "the person turned the Inbox on here"
 * (packages/shared/inbox/inbox-on.ts): who counts as the person, the
 * refusal every start gives while it is off, and `plannotator inbox on` /
 * `plannotator inbox off`.
 *
 * The person's acts: their own `plannotator inbox` (or `--no-open`, or
 * `--open`) in their own terminal, their `/plannotator-inbox` (the command
 * passes INBOX_SLASH_COMMAND_FLAG to the `plannotator inbox --open` it runs),
 * `plannotator inbox on` in their own terminal.
 *
 * "Their own terminal" (personsTerminal): no agent's marker
 * (INBOX_AGENT_SHELL_MARKERS: the variables agents set in the shells they
 * start), no login item's marker (INBOX_HOST_START_MARKERS), and a terminal on
 * both stdin and stdout. An agent's shell tool runs commands without a
 * terminal, and so do launchd and systemd, so an agent the list does not know
 * (Amp, Droid, Kiro, Cline, Hermes, OpenClaw, Goose, ...) is refused like one
 * it knows. The gap left: an agent with no marker that runs commands in a real
 * terminal (an IDE agent typing into the integrated terminal) looks like the
 * person; its `plannotator inbox` then opens the window in front of them.
 */

import { INBOX_QWEN_SESSION_ENV, INBOX_T3_THREAD_ENV } from "@plannotator/core/inbox-types";
import { INBOX_OFF_AGENT_LINE, INBOX_OFF_PERSON_LINE, isInboxOn, readInboxOnRecord, turnInboxOn } from "@plannotator/shared/inbox/inbox-on";
import { INBOX_ON_NOT_SAVED } from "@plannotator/shared/inbox/inbox-on-config";
import { inboxOffReport, turnInboxOff } from "@plannotator/server/inbox-on-settle";

/**
 * The variables agents set in the shells (and MCP servers) they start: the
 * union of the ones detect-origin.ts, `plannotator inbox call` and the Inbox
 * shim already read. Any one of them set means an agent runs this command.
 */
export const INBOX_AGENT_SHELL_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "PLANNOTATOR_SESSION_TAG",
  INBOX_T3_THREAD_ENV,
  "CODEX_THREAD_ID",
  "PI_SESSION_ID",
  "OMPCODE",
  "OPENCODE",
  "GEMINI_CLI",
  INBOX_QWEN_SESSION_ENV,
  "QWEN_CODE",
  "COPILOT_CLI",
  "CURSOR_AGENT",
  "DSH_SHELL",
  "DSH_SESSION_ID",
] as const;

/**
 * Starts that are never the person at a terminal, though they have none of an
 * agent's markers: the routines' start at login (inbox-scheduled-login.ts sets
 * PLANNOTATOR_INBOX_LOGIN_ITEM; a login item written before it is launchd's
 * job `ai.plannotator.inbox`). With no terminal they are refused anyway; this
 * names them.
 */
export const INBOX_HOST_START_MARKERS: readonly { name: string; value?: string }[] = [
  { name: "PLANNOTATOR_INBOX_LOGIN_ITEM" },
  { name: "XPC_SERVICE_NAME", value: "ai.plannotator.inbox" },
];

type Env = Readonly<Record<string, string | undefined>>;

/** The first agent marker set in `env`, or null (a person's terminal, or an agent the list does not know). */
export function inboxAgentShell(env: Env): string | null {
  return INBOX_AGENT_SHELL_MARKERS.find((name) => !!env[name]?.trim()) ?? null;
}

/** Whether this process has a terminal on stdin and stdout (a person typing), as opposed to an agent's shell tool, a pipe or a login item. */
export function hasTerminal(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Whether the command runs in the person's own terminal: no agent's or login item's marker, and a terminal (see the file header). */
export function personsTerminal(env: Env, tty: boolean = hasTerminal()): boolean {
  if (inboxAgentShell(env)) return false;
  if (INBOX_HOST_START_MARKERS.some(({ name, value }) => (value === undefined ? !!env[name]?.trim() : env[name] === value))) return false;
  return tty;
}

/** The refusal while the Inbox is off: the person's line only in their own terminal, else the agents' (which never says how to turn it on). */
export function inboxOffLine(env: Env, tty: boolean = hasTerminal()): string {
  return personsTerminal(env, tty) ? INBOX_OFF_PERSON_LINE : INBOX_OFF_AGENT_LINE;
}

/** A start refused because the Inbox is off: its message is the one line to print or answer. */
export class InboxOffError extends Error {
  constructor(env: Env = process.env, tty: boolean = hasTerminal()) {
    super(inboxOffLine(env, tty));
    this.name = "InboxOffError";
  }
}

/** Throws InboxOffError while the Inbox is off: the guard in front of every start. */
export function assertInboxOn(dataDir: string, env: Env = process.env, tty: boolean = hasTerminal()): void {
  if (!isInboxOn(dataDir, env)) throw new InboxOffError(env, tty);
}

/** How a `plannotator inbox` run was started. */
export interface InboxRunKind {
  detached: boolean;
  background: boolean;
  /** INBOX_SLASH_COMMAND_FLAG was passed: Plannotator's `/plannotator-inbox`, which only the person types. */
  slashCommand?: boolean;
  /** Default: whether this process has a terminal on stdin and stdout. */
  tty?: boolean;
}

/**
 * Whether this run of `plannotator inbox` (bare, `--no-open` or `--open`) is
 * the person's own act, and so turns the Inbox on: `/plannotator-inbox` (its
 * flag), or the person's own terminal. Never a detached start and never
 * `--background`.
 */
export function isPersonsInboxRun(env: Env, run: InboxRunKind): boolean {
  if (run.detached || run.background) return false;
  if (run.slashCommand) return true;
  return personsTerminal(env, run.tty ?? hasTerminal());
}

/**
 * Before a `plannotator inbox` run starts or opens anything: the person's run
 * turns the Inbox on (`slash-command` or `command`; a record that cannot be
 * written is said plainly and nothing starts); any other run while it is off
 * is refused with the one line (printed, exit 1).
 */
export function inboxRunMayStart(dataDir: string, env: Env, run: InboxRunKind): { ok: true } | { ok: false; line: string } {
  if (isPersonsInboxRun(env, run)) {
    return turnInboxOn(run.slashCommand ? "slash-command" : "command", dataDir) ? { ok: true } : { ok: false, line: INBOX_ON_NOT_SAVED };
  }
  return isInboxOn(dataDir, env) ? { ok: true } : { ok: false, line: inboxOffLine(env, run.tty ?? hasTerminal()) };
}

/** The lines `plannotator inbox on` prints. */
export const INBOX_ON_LINES = [
  "The Plannotator Inbox is on: agents get it from their next session.",
  "Open it with plannotator inbox. Turn it off with plannotator inbox off.",
];

/** `plannotator inbox on`: the person's switch, in their own terminal only (anywhere else it is refused: only the person turns it on). */
export function inboxOnCommand(dataDir: string, env: Env, write: (line: string) => void, tty: boolean = hasTerminal()): number {
  if (!personsTerminal(env, tty)) {
    write(INBOX_OFF_AGENT_LINE);
    return 1;
  }
  if (!turnInboxOn("inbox-on", dataDir)) {
    write(INBOX_ON_NOT_SAVED);
    return 1;
  }
  for (const line of INBOX_ON_LINES) write(line);
  return 0;
}

/** `plannotator inbox off`: stop it, record off, remove Plannotator's untouched notes, say how to turn it back on. */
export async function inboxOffCommand(dataDir: string, write: (line: string) => void): Promise<number> {
  const off = await turnInboxOff(dataDir);
  for (const line of inboxOffReport(off)) write(line);
  return off.recorded ? 0 : 1;
}

/** Why the Inbox is on or off, for `plannotator inbox status` (the record's `by`). */
const INBOX_ON_WHY: Record<string, string> = {
  command: "turned on by plannotator inbox in a terminal",
  "slash-command": "turned on by /plannotator-inbox",
  "inbox-on": "turned on by plannotator inbox on",
  settings: "turned on in Settings",
  off: "turned off",
  "update-used": "kept on when Plannotator updated: the Inbox window had been used here",
  "update-ran": "kept on when Plannotator updated: plannotator inbox had been run here",
  "update-agent-only": "off since Plannotator updated: only agents had started the Inbox here",
  "record-lost": "off: its record in state.json was lost",
};

/** `plannotator inbox status`: whether the Inbox is on here, why and since when (the JSON report's `inbox_on`). */
export function inboxOnStatus(dataDir: string): { on: boolean; by: string | null; at: string | null; notes_left: boolean } {
  const record = readInboxOnRecord(dataDir);
  return { on: record?.on === true, by: record?.by ?? null, at: record?.at || null, notes_left: record?.notes === "left" };
}

/** The status lines for it. */
export function inboxOnStatusLines(dataDir: string): string[] {
  const status = inboxOnStatus(dataDir);
  const why = status.by ? (INBOX_ON_WHY[status.by] ?? status.by) : "never turned on here";
  const lines = [`  turned:   ${status.on ? "on" : "off"} (${why}${status.at ? `, ${status.at}` : ""})`];
  if (status.notes_left) lines.push("  notes:    some of Plannotator's notes in agents' instruction files could not be removed; plannotator inbox off tries again");
  return lines;
}
