/**
 * Around a list's rows (rowParts.tsx `ListRows`): the agents' faces heard once for every row's icon. A list mounts every
 * row of its open groups (about 2,200 on a large Inbox), and each icon watched its own agent's face and tile choice:
 * two store subscriptions per row. The icons read the face as they draw (agentFaces.ts `agentFaceOf`,
 * `agentTakesTiles`) and draw again when any face changes, which is rare (a face picked, the faces read on load).
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { agentFacesRev, subscribeAgentFaces } from './agentFaces';

const ListAgentFaces = createContext<number | null>(null);

export function ListAgentFacesScope({ children }: { children: ReactNode }) {
  const rev = useSyncExternalStore(subscribeAgentFaces, agentFacesRev, agentFacesRev);
  return <ListAgentFaces.Provider value={rev}>{children}</ListAgentFaces.Provider>;
}

/** The faces' revision inside a list's rows; null outside one, where an icon watches its own agent's face. */
export function useListAgentFaces(): number | null {
  return useContext(ListAgentFaces);
}
