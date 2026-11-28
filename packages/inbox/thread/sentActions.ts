/** The person's own sent replies list the action items they carried (approval "inbox-action-items-in-reply"). */
import { inboxActionPersonMark, type InboxMessageWire } from '@plannotator/core/inbox-types';
import type { ActionRow } from '../components/ReplyAnswers';

/** Each sent reply's action rows (by the reply's id): only the person's marks, as sent at their latest revision. */
export function sentActionsOf(messages: readonly InboxMessageWire[]): Map<string, ActionRow[]> {
  const out = new Map<string, ActionRow[]>();
  for (const m of messages) {
    for (const a of m.actions ?? []) {
      const result = a.action_result;
      const mine = inboxActionPersonMark(result);
      if (!result || !mine || !a.sent_reply_id || a.revision === 0 || a.sent_revision !== a.revision) continue;
      out.set(a.sent_reply_id, [
        ...(out.get(a.sent_reply_id) ?? []),
        { id: `${m.id}/${a.key}`, messageId: m.id, number: a.position + 1, prompt: a.prompt, outcome: mine.outcome, note: mine.note, seen: result.by === 'agent' },
      ]);
    }
  }
  return out;
}
