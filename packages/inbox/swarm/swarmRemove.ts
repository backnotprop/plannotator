/**
 * Remove in the swarm's status view: main's Remove an agent from a thread (approval "inbox-remove-agent-from-thread";
 * data/actions/removeAgent.ts), one press, no dialog, its toast and Undo in the same words. In a swarm the agent leaves
 * the members, the status view and the ghost thread's "everyone" (packages/shared/inbox/swarm.ts); its ghost words stay.
 */
import { InboxHeldError } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { postRemoveAgent, postUndoRemoveAgent } from '../data/actions/removeAgent';

export interface SwarmRemoveHost {
  threadId: string;
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  /** Read the thread again: the agent gone, or back. */
  changed?: () => Promise<void> | void;
}

const warn = (host: SwarmRemoveHost, cause: unknown) => host.onToast?.({ icon: 'warn', lead: cause instanceof Error ? cause.message : String(cause), wrap: true });

export async function removeSwarmAgent(host: SwarmRemoveHost, session: string, name: string): Promise<void> {
  try {
    await postRemoveAgent(host.threadId, session);
  } catch (cause) {
    // Held for a linked computer that is away: the thread's held writes say so, and it goes when that one is back.
    if (!(cause instanceof InboxHeldError)) warn(host, cause);
    return void (await host.changed?.());
  }
  host.onToast?.({
    icon: 'check',
    lead: `Removed ${name}`,
    phoneLead: 'Removed',
    speech: `Removed ${name} from this thread. Undo brings it back for a few seconds.`,
    onUndo: () =>
      void postUndoRemoveAgent(host.threadId, session).then(
        () => host.changed?.(),
        (cause: unknown) => {
          if (!(cause instanceof InboxHeldError)) warn(host, cause);
          return host.changed?.();
        },
      ),
  });
  await host.changed?.();
}
