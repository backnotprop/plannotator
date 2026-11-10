/**
 * The face each agent's icon shows (the sidebar's Agents picker, approval "inbox-agent-icon-motion"), saved by the
 * Inbox so every window, the phone's and the iPad's too, draws the same face for the same agent everywhere: its row
 * in the sidebar, the list's rows, the thread, the reply box, the starred pills, New message.
 *
 * An entry is keyed by the agent's id as the list names it (`InboxAgent.id`: a launch's id, else its session id) and
 * says every session id that agent was or is (`sessions`): its session, the ones its conversation continues, and the
 * ones the Inbox linked to it later (a launch's session once it started, a conversation that went on under a new id).
 * A row only knows the sessions that wrote in it, so a face is found by any of them, after the agent ended too.
 *
 * Kept in `inbox/agent-faces.json` (packages/shared/inbox/agent-faces.ts), outside the event log and config.json: it is
 * window furniture. Nothing of it leaves this computer.
 */

/** The Glass colours, round the hue wheel: Black and Yellow keep the ids they were stored under (`glass`, `yellow`). */
export const INBOX_GLASS_FACES = ['glass', 'glass-red', 'glass-orange', 'yellow', 'glass-green', 'glass-teal', 'glass-blue', 'glass-purple', 'glass-pink', 'glass-ice'] as const;
export type InboxGlassFace = (typeof INBOX_GLASS_FACES)[number];
/** `agent`: the agent's own mark (never stored); then the Glass colours, Transparent and Face (`totman`). */
export type InboxAgentFace = 'agent' | InboxGlassFace | 'transparent' | 'totman';

/** Every face, in the picker's order. */
export const INBOX_AGENT_FACES: readonly InboxAgentFace[] = ['agent', ...INBOX_GLASS_FACES, 'transparent', 'totman'];

export const isInboxAgentFace = (value: unknown): value is InboxAgentFace => typeof value === 'string' && (INBOX_AGENT_FACES as readonly string[]).includes(value);

/** The most agents a person's faces are kept for: the latest choice last, the oldest forgotten past this. */
export const INBOX_AGENT_FACES_KEPT = 200;
/** The most session ids one agent's entry keeps (the newest linked last). */
export const INBOX_AGENT_FACE_SESSIONS_MAX = 16;
/** The longest agent or session id an entry takes. */
export const INBOX_AGENT_FACE_ID_MAX = 200;

/** One agent's face. */
export interface InboxAgentFaceEntry {
  face: Exclude<InboxAgentFace, 'agent'>;
  /** Every session id this agent was or is (never its key itself), oldest first. */
  sessions: string[];
}

/** `GET /api/inbox/agent-faces`, a write's answer and `event: agent-faces`. `rev` counts the saves. */
export interface InboxAgentFacesWire {
  faces: Record<string, InboxAgentFaceEntry>;
  rev: number;
}

/** `POST /api/inbox/agent-faces`: one agent's face (`agent`: forget it), or this browser's faces from before (`adopt`). */
export type InboxAgentFaceChange = { agent: string; sessions?: string[]; face: InboxAgentFace } | { adopt: Record<string, InboxAgentFace> };

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= INBOX_AGENT_FACE_ID_MAX && value.trim() === value;

/** A list of session ids as an entry keeps it: ids only, no repeat, never `key`, at most the newest MAX. */
export function cleanInboxFaceSessions(value: unknown, key: string): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) if (isId(item) && item !== key && !out.includes(item)) out.push(item);
  return out.slice(-INBOX_AGENT_FACE_SESSIONS_MAX);
}

/** A faces map as read from a file, a write's answer or an event: entries that do not parse are dropped. */
export function readInboxAgentFaces(value: unknown): Record<string, InboxAgentFaceEntry> {
  const out = Object.create(null) as Record<string, InboxAgentFaceEntry>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as { face?: unknown; sessions?: unknown } | null;
    if (!isId(key) || !entry || typeof entry !== 'object' || !isInboxAgentFace(entry.face) || entry.face === 'agent') continue;
    out[key] = { face: entry.face, sessions: cleanInboxFaceSessions(entry.sessions, key) };
  }
  return out;
}

/** Whether `id` is a key or session an agent face entry may name. */
export const isInboxAgentFaceId = isId;
