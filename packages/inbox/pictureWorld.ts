/**
 * A picture's own made-up agents and faces (the view choice dialog's demo, components/viewChoiceDemo.ts). Inside one,
 * the agents hooks hand out (`useInboxAgents`, `useRowSessions`) and each agent's face (`useAgentFace`) are the
 * picture's, never the person's: the picture is the same for everyone, and it reads nothing of theirs.
 */
import { createContext, useContext } from 'react';
import type { InboxAgentsGroup } from '@plannotator/core/inbox-types';
import type { AgentFace } from './agents/faceChoices';

export interface PictureWorld {
  agents: readonly InboxAgentsGroup[];
  /** Each agent's face by its id (and session); none: its own mark. */
  faces: ReadonlyMap<string, AgentFace>;
}

export const PictureWorldContext = createContext<PictureWorld | null>(null);

/** The picture drawn here, or null in the window itself. */
export const usePictureWorld = (): PictureWorld | null => useContext(PictureWorldContext);
