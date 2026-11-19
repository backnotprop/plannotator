/**
 * The CLI's side of "the Inbox is on here" (packages/shared/inbox/inbox-on.ts):
 * what turns it on, the refusal every other start gives while it is off, and
 * `plannotator inbox off`.
 *
 * Running `plannotator inbox` (bare, `--no-open` or `--open`) turns the Inbox
 * on, whoever runs it; `/plannotator-inbox` just runs it. Plannotator's own
 * starts never turn it on: `--background`, a detached start (an agent call's
 * background start, the window's Restart, an update's restart) and the
 * routines' start at login. While it is off they start nothing.
 */

import { INBOX_OFF_AGENT_LINE, isInboxOn, readInboxOnRecord, turnInboxOn } from "@plannotator/shared/inbox/inbox-on";
import { INBOX_ON_NOT_SAVED } from "@plannotator/shared/inbox/inbox-on-config";
import { inboxOffReport, turnInboxOff } from "@plannotator/server/inbox-on-settle";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether this process is the routines' start at login: inbox-scheduled-login.ts
 * sets PLANNOTATOR_INBOX_LOGIN_ITEM; a login item written before it is launchd's
 * job `ai.plannotator.inbox`. Our launcher naming itself, so its run never turns
 * the Inbox on.
 */
export function isOurLoginItem(env: Env): boolean {
  return !!env.PLANNOTATOR_INBOX_LOGIN_ITEM?.trim() || env.XPC_SERVICE_NAME === "ai.plannotator.inbox";
}

/** A start refused because the Inbox is off: its message is the one line to print or answer. */
export class InboxOffError extends Error {
  constructor() {
    super(INBOX_OFF_AGENT_LINE);
    this.name = "InboxOffError";
  }
}

/** Throws InboxOffError while the Inbox is off: the guard in front of every start. */
export function assertInboxOn(dataDir: string, env: Env = process.env): void {
  if (!isInboxOn(dataDir, env)) throw new InboxOffError();
}

/** How a `plannotator inbox` run was started. */
export interface InboxRunKind {
  detached: boolean;
  background: boolean;
  loginItem: boolean;
}

/**
 * Before a `plannotator inbox` run starts or opens anything: a run of
 * `plannotator inbox` itself turns the Inbox on (a record that cannot be
 * written is said plainly and nothing starts); Plannotator's own starts while
 * it is off are refused with the one line (printed, exit 1).
 */
export function inboxRunMayStart(dataDir: string, env: Env, run: InboxRunKind): { ok: true } | { ok: false; line: string } {
  if (!run.detached && !run.background && !run.loginItem) {
    return turnInboxOn("command", dataDir) ? { ok: true } : { ok: false, line: INBOX_ON_NOT_SAVED };
  }
  return isInboxOn(dataDir, env) ? { ok: true } : { ok: false, line: INBOX_OFF_AGENT_LINE };
}

/** `plannotator inbox off`: stop it, record off, remove Plannotator's untouched notes, say how to turn it back on. */
export async function inboxOffCommand(dataDir: string, write: (line: string) => void): Promise<number> {
  const off = await turnInboxOff(dataDir);
  for (const line of inboxOffReport(off)) write(line);
  return off.recorded ? 0 : 1;
}

/** Why the Inbox is on or off, for `plannotator inbox status` (the record's `by`). */
const INBOX_ON_WHY: Record<string, string> = {
  command: "turned on by plannotator inbox",
  off: "turned off",
  "update-used": "kept on when Plannotator updated: the Inbox window had been used here",
  "update-ran": "kept on when Plannotator updated: plannotator inbox had been run here",
  "update-agent-only": "off since Plannotator updated: only agents had started the Inbox here",
  "update-slow": "kept on when Plannotator updated: the Inbox's files took too long to read",
};

/** `record-lost` reads the store again, so it can be either. */
function why(by: string, on: boolean): string {
  if (by === "record-lost") return on ? "kept on: its record in state.json was lost and the Inbox had been used here" : "off: its record in state.json was lost";
  return INBOX_ON_WHY[by] ?? by;
}

/** `plannotator inbox status`: whether the Inbox is on here, why and since when (the JSON report's `inbox_on`). */
export function inboxOnStatus(dataDir: string): { on: boolean; by: string | null; at: string | null } {
  const record = readInboxOnRecord(dataDir);
  return { on: record?.on === true, by: record?.by ?? null, at: record?.at || null };
}

/** The status line for it. */
export function inboxOnStatusLines(dataDir: string): string[] {
  const status = inboxOnStatus(dataDir);
  const reason = status.by ? why(status.by, status.on) : "never turned on here";
  return [`  turned:   ${status.on ? "on" : "off"} (${reason}${status.at ? `, ${status.at}` : ""})`];
}
