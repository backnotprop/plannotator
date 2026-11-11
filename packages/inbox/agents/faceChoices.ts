import { INBOX_AGENT_FACES, INBOX_GLASS_FACES, isInboxAgentFace, isInboxOwnFace, type InboxAgentFace, type InboxBuiltInFace, type InboxGlassFace, type InboxOwnFace } from '@plannotator/core/inbox-types';

export const GLASS_FACES = INBOX_GLASS_FACES;
export type GlassFace = InboxGlassFace;
export type AgentFace = InboxAgentFace;
export type OurFace = Exclude<InboxBuiltInFace, 'agent'>;
export type OwnFace = InboxOwnFace;
export const isOwnFace = isInboxOwnFace;

export const AGENT_FACES: readonly InboxBuiltInFace[] = INBOX_AGENT_FACES;

export const AGENT_FACE_CYCLE: readonly AgentFace[] = ['agent', 'glass', 'yellow', 'transparent', 'totman'];

export function nextAgentFace(face: AgentFace): AgentFace {
  const at = AGENT_FACE_CYCLE.indexOf(face);
  return at < 0 ? 'transparent' : AGENT_FACE_CYCLE[(at + 1) % AGENT_FACE_CYCLE.length]!;
}

export const isAgentFace = isInboxAgentFace;

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
