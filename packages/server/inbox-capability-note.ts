/**
 * A capability switch an agent on a linked computer turned here (docs/agent-guides/inbox-machines.md, "Capabilities
 * on a linked computer"): the person on this computer sees it on this computer too. The other computer's `POST
 * capabilities` carries `capability_note` (only to a computer whose list takes the mark `capability-note`): the agent's
 * name and host, nothing else. This Inbox writes the line itself from what it checks: which switch, which way (from the
 * write it applied), the agent's name cleaned to one short line, and that computer's name as this Inbox's link has it.
 * Never words of the other computer's. As the local line: an Inbox note, no sound, in the agent's thread here.
 */
import { INBOX_CAPABILITY_SWITCHES } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** The door field, and the mark a computer's list says it takes it with. */
export const CAPABILITY_NOTE_FIELD = "capability_note";
export const CAPABILITY_NOTE_MARK = "capability-note";

export interface CapabilityNote {
  agent: string;
  host: string | null;
}

const NAME_MAX = 60;

/** The field as the other computer sent it, checked: null when it is not one (the write still applies). */
export function capabilityNoteOf(value: unknown): CapabilityNote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { agent, host } = value as { agent?: unknown; host?: unknown };
  // Letters, digits, spaces and . _ ' - only: no markdown, link, mention or control character reaches the line.
  const name = typeof agent === "string" ? agent.replace(/[^\p{L}\p{N} ._'-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim() : "";
  return { agent: name || "An agent", host: typeof host === "string" && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(host) ? host : null };
}

/** The lines for the switches the write turned: "Claude Code on MacBook turned on Routines." */
export function capabilityNoteLines(note: CapabilityNote, machineName: string, written: Record<string, unknown>): string[] {
  return INBOX_CAPABILITY_SWITCHES.flatMap(({ key, name }) => {
    const value = written[key] as { on?: unknown } | undefined;
    return value && typeof value.on === "boolean" ? [`${note.agent} on ${machineName} turned ${value.on ? "on" : "off"} ${name}.`] : [];
  });
}

/**
 * Post them, as the agent (no session here: it runs on the other computer), in its own thread here: the open thread
 * of that name in `projectId` (one per agent and computer), else a new one.
 */
export function postCapabilityNotes(store: InboxStore, projectId: string, note: CapabilityNote, machineName: string, written: Record<string, unknown>): string | null {
  let thread: string | null = null;
  for (const body of capabilityNoteLines(note, machineName, written)) {
    const author = { kind: "agent" as const, host: note.host, session: null, name: note.agent };
    thread = store.sendMessage({ author, body, launch_note: true, project_id: projectId, thread: `${note.agent} on ${machineName}`.slice(0, 120), subject: body }).message.thread_id;
  }
  return thread;
}
