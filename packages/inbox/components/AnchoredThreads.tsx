import { createContext, useContext } from 'react';
import { Icon } from '../icons';

/** The threads that have a thread tab open now (threadTabs.ts), as the main tab's list marks them. */
export const AnchoredThreadsContext = createContext<ReadonlySet<string>>(new Set());

/** A small mark on a list row whose thread is open in its own tab; nothing for any other. */
export function AnchoredMark({ thread }: { thread: string }) {
  const anchored = useContext(AnchoredThreadsContext);
  if (!anchored.has(thread)) return null;
  return (
    <span className="ib-anchored" title="Open in its own tab" role="img" aria-label="Open in its own tab" data-anchored-mark="">
      <Icon name="external" size={12} />
    </span>
  );
}
