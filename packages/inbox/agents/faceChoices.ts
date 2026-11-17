export * from '@plannotator/ui/components/agentFace/faceChoices';
import type { InboxAgentFace, InboxAgentTile } from '@plannotator/core/inbox-types';

/**
 * A face as this window keeps it for an agent: a stored face (core `InboxAgentFace`), or a tile choice (`project`, its
 * project's tile; `mark`, its own mark picked under "From the project name"), which the Inbox stores beside
 * `face: "agent"` (an entry's `tile`, agents/agentFaces.ts) so an older Plannotator keeps the entry.
 */
export type AgentFace = InboxAgentFace | InboxAgentTile;
