/**
 * The faces an agent's mark can show: its own mark, the Glass colours (glassArt.ts), Transparent and Face (the
 * mascot). The picker (FaceFan.tsx) offers all of them; a click on the mark steps through the first cycle, as before.
 */

// The face ids are the Inbox's (core inbox-agent-faces.ts: the server keeps each agent's face).
import { INBOX_AGENT_FACES, INBOX_GLASS_FACES, type InboxAgentFace, type InboxGlassFace } from '@plannotator/core/inbox-agent-faces';

/** The Glass colours, round the hue wheel: Black and Yellow keep the ids they were stored under (`glass`, `yellow`). */
export const GLASS_FACES = INBOX_GLASS_FACES;
export type GlassFace = InboxGlassFace;
export type AgentFace = InboxAgentFace;
export type OurFace = Exclude<AgentFace, 'agent'>;

/** Every face, in the picker's order. */
export const AGENT_FACES: readonly AgentFace[] = INBOX_AGENT_FACES;

/** The click cycle (the owner, 2026-11-09): each stays until the next click. */
export const AGENT_FACE_CYCLE: readonly AgentFace[] = ['agent', 'glass', 'yellow', 'transparent', 'totman'];

/** The face a click shows next: the cycle's next; from a colour only the picker gives, the step after the colours. */
export function nextAgentFace(face: AgentFace): AgentFace {
  const at = AGENT_FACE_CYCLE.indexOf(face);
  return at < 0 ? 'transparent' : AGENT_FACE_CYCLE[(at + 1) % AGENT_FACE_CYCLE.length]!;
}

export const isAgentFace = (value: unknown): value is AgentFace => typeof value === 'string' && (AGENT_FACES as readonly string[]).includes(value);

/** Each of our faces' name (a picker choice's accessible name). */
export const FACE_LABELS: Readonly<Record<OurFace, string>> = {
  glass: 'Black glass',
  'glass-red': 'Red glass',
  'glass-orange': 'Orange glass',
  yellow: 'Yellow glass',
  'glass-green': 'Green glass',
  'glass-teal': 'Teal glass',
  'glass-blue': 'Blue glass',
  'glass-purple': 'Purple glass',
  'glass-pink': 'Pink glass',
  'glass-ice': 'Ice glass',
  transparent: 'Transparent',
  totman: 'Face',
};
