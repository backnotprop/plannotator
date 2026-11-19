/**
 * The CLI's side of "the person turned the Inbox on here"
 * (packages/shared/inbox/inbox-on.ts): who counts as the person, the
 * refusal every start gives while it is off, and `plannotator inbox on` /
 * `plannotator inbox off`.
 *
 * The person's acts: their own `plannotator inbox` (or `--no-open`, or
 * `--open`) in a terminal that is not an agent's shell, their
 * `/plannotator-inbox` (the command sets INBOX_SLASH_COMMAND_ENV on the
 * `plannotator inbox --open` it runs), `plannotator inbox on` outside an
 * agent's shell. An agent's shell is known by the variables agents set in the
 * shells they start (INBOX_AGENT_SHELL_MARKERS); an agent this list does not
 * know looks like a person's terminal, and its `plannotator inbox` opens the
 * window in front of the person, who then sees the Inbox they are turning on.
 */

import { INBOX_QWEN_SESSION_ENV, INBOX_T3_THREAD_ENV } from "@plannotator/core/inbox-types";
import {
  INBOX_OFF_AGENT_LINE,
  INBOX_OFF_PERSON_LINE,
  INBOX_SLASH_COMMAND_ENV,
  isInboxOn,
  turnInboxOn,
} from "@plannotator/shared/inbox/inbox-on";
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

/** The first agent marker set in `env`, or null (a person's terminal, or an agent the list does not know). */
export function inboxAgentShell(env: Readonly<Record<string, string | undefined>>): string | null {
  return INBOX_AGENT_SHELL_MARKERS.find((name) => !!env[name]?.trim()) ?? null;
}

/** The refusal while the Inbox is off: the agents' line in an agent's shell, else the person's. */
export function inboxOffLine(env: Readonly<Record<string, string | undefined>>): string {
  return inboxAgentShell(env) ? INBOX_OFF_AGENT_LINE : INBOX_OFF_PERSON_LINE;
}

/** A start refused because the Inbox is off: its message is the one line to print or answer. */
export class InboxOffError extends Error {
  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    super(inboxOffLine(env));
    this.name = "InboxOffError";
  }
}

/** Throws InboxOffError while the Inbox is off: the guard in front of every start. */
export function assertInboxOn(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (!isInboxOn(dataDir, env)) throw new InboxOffError(env);
}

/**
 * Whether this run of `plannotator inbox` (bare, `--no-open` or `--open`) is
 * the person's own act, and so turns the Inbox on: `/plannotator-inbox` (the
 * command's marker), or a terminal that is not an agent's shell. Never a
 * detached start and never `--background`.
 */
export function isPersonsInboxRun(env: Readonly<Record<string, string | undefined>>, run: { detached: boolean; background: boolean }): boolean {
  if (run.detached || run.background) return false;
  if (env[INBOX_SLASH_COMMAND_ENV]?.trim() === "1") return true;
  return inboxAgentShell(env) === null;
}

/**
 * Before a `plannotator inbox` run starts or opens anything: the person's run
 * turns the Inbox on (`slash-command` or `command`); any other run while it is
 * off is refused with the one line (printed, exit 1).
 */
export function inboxRunMayStart(dataDir: string, env: Readonly<Record<string, string | undefined>>, run: { detached: boolean; background: boolean }): { ok: true } | { ok: false; line: string } {
  if (isPersonsInboxRun(env, run)) {
    turnInboxOn(env[INBOX_SLASH_COMMAND_ENV]?.trim() === "1" ? "slash-command" : "command", dataDir);
    return { ok: true };
  }
  return isInboxOn(dataDir, env) ? { ok: true } : { ok: false, line: inboxOffLine(env) };
}

/** The lines `plannotator inbox on` prints. */
export const INBOX_ON_LINES = [
  "The Plannotator Inbox is on: agents get it from their next session.",
  "Open it with plannotator inbox. Turn it off with plannotator inbox off.",
];

/** `plannotator inbox on`: the person's switch. In an agent's shell it is refused (only the person turns it on). */
export function inboxOnCommand(dataDir: string, env: Readonly<Record<string, string | undefined>>, write: (line: string) => void): number {
  if (inboxAgentShell(env)) {
    write(INBOX_OFF_AGENT_LINE);
    return 1;
  }
  if (!turnInboxOn("inbox-on", dataDir)) {
    write("Could not turn the Plannotator Inbox on: state.json in Plannotator's data folder could not be written.");
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
