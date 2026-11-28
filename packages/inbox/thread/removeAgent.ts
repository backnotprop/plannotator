/**
 * Remove on a row of the reply's "to" list, or a phone sheet row's swipe (approval "inbox-remove-agent-from-thread"):
 * one press, no dialog. The agent leaves the thread (data/actions/removeAgent.ts); the toast says "Removed webhooks"
 * ("Removed" on a phone) with the toast's own Undo, the same toast a hand-off uses. The reply's choice drops it, and
 * focus that was on its Remove goes back to the reply's words. A plain function of its host, made per render.
 */
import { InboxApiError, InboxHeldError } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { postRemoveAgent, postUndoRemoveAgent } from '../data/actions/removeAgent';
import type { RecipientRow } from '../replyRecipients';
import type { SessionLabels } from '../sessionLabels';
import { recipientNames } from './recipientNames';

export interface RemoveAgentHost {
  threadId: string;
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  /** Read the thread again: it shows the agent gone, or back. */
  changed: () => Promise<void>;
  /** Each session's title and folder, which name a row as the list does (thread/recipientNames.ts). */
  labels: SessionLabels;
  folderOf: (session: string) => string;
  /** Every row of the list, and who the reply goes to now (the person's pick, else null). */
  rows: readonly RecipientRow[];
  picked: readonly string[] | null;
  aim: (pick: readonly string[]) => void;
  /** The reply's words, for focus left nowhere. */
  field: () => HTMLElement | null;
}

export function removeAgentAction(host: RemoveAgentHost) {
  /** Undo: the agent back, then the person's pick as it was before the press (`pick`, when the press changed it). */
  const undo = async (session: string, pick: readonly string[] | null) => {
    try {
      await postUndoRemoveAgent(host.threadId, session);
    } catch (cause) {
      if (!(cause instanceof InboxHeldError)) host.onToast?.({ icon: 'warn', lead: cause instanceof Error ? cause.message : String(cause), wrap: true });
      return void (await host.changed());
    }
    await host.changed();
    if (pick) host.aim(pick);
  };
  return async (row: RecipientRow) => {
    const name = recipientNames(host.rows, host.labels, host.folderOf).get(row.session)?.name ?? row.label;
    /** Its Remove had focus (Tab, then Enter): it is gone after, so focus goes back to the words. */
    const focused = !!(document.activeElement as Element | null)?.matches?.('[data-recipient-remove]');
    try {
      await postRemoveAgent(host.threadId, row.session);
    } catch (cause) {
      // Held for a linked machine that is away: the thread's held writes say so, and it goes when that machine is back.
      if (cause instanceof InboxHeldError) return void (await host.changed());
      host.onToast?.({ icon: 'warn', lead: cause instanceof InboxApiError || cause instanceof Error ? cause.message : String(cause), wrap: true });
      return;
    }
    // The person's choice without it: the rest, else the first other agent that can take the reply alone (a live one
    // first). Undo puts the choice back as it was.
    const before = host.picked ? [...host.picked] : null;
    let changedPick = false;
    if (before?.includes(row.session)) {
      const rest = before.filter((id) => id !== row.session);
      const others = host.rows.filter((r) => r.session !== row.session && r.alone !== false && !r.start);
      const next = rest.length > 0 ? rest : [...others.filter((r) => r.state === 'live'), ...others].map((r) => r.session).slice(0, 1);
      if (next.length > 0) {
        host.aim(next);
        changedPick = true;
      }
    }
    host.onToast?.({
      icon: 'check',
      lead: `Removed ${name}`,
      phoneLead: 'Removed',
      speech: `Removed ${name} from this thread. Undo brings it back for a few seconds.`,
      onUndo: () => void undo(row.session, changedPick ? before : null),
    });
    await host.changed();
    // Its Remove had focus and is gone (or the whole list, with one agent left): back to the words.
    if (focused) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected) host.field()?.focus({ preventScroll: true });
      });
    }
  };
}
