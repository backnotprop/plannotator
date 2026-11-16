/**
 * The row menu's Mention in reply (approval "inbox-drag-threads", piece 1): the non-drag way to mention a thread, for
 * a keyboard (Shift+F10 or the menu key on a row), a screen reader and a phone (the row's sheet). With several rows
 * picked it reads "Mention 3 in reply". It goes to the reply of the thread open beside the list; on a phone, or on a
 * computer with no thread open, to the reply the person last wrote in, which the item names. On the open thread
 * itself it is disabled and says "This thread".
 */
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { useInboxQueryClient } from '../data/client';
import { knownMentionRef, mentionRefOf, noteMentionRefs } from '../data/threadMentionRefs';
import { mentionInReply, mentionTarget } from '../threadMentions';
import { ThreadGlyph } from '../replyMentions';

export function MentionMenuItem({ rows, phone }: { rows: readonly InboxListRow[]; phone: boolean }) {
  const client = useInboxQueryClient();
  const aim = rows.length > 0 ? mentionTarget(phone) : null;
  if (!aim) return null;
  const target = aim.thread;
  const others = rows.filter((row) => row.thread_id !== target);
  const same = others.length === 0;
  const label = rows.length > 1 ? `Mention ${formatCount(rows.length)} in reply` : 'Mention in reply';
  // A reply that is not the thread on screen (a phone's sheet, phone.html, or a computer with none open) is named.
  const into = !aim.open && !same ? (knownMentionRef(client, target)?.title ?? 'the reply you last wrote') : null;
  return (
    <Menu.Item
      className="ib-pmi"
      label={label}
      disabled={same}
      data-row-action="mention"
      onClick={() => {
        const refs = others.map(mentionRefOf);
        noteMentionRefs(refs);
        // After the menu has closed and put focus back on the row: the reply's field takes it from there.
        setTimeout(() => mentionInReply(target, refs), 0);
      }}
    >
      <ThreadGlyph size={15} />
      {label}
      {same ? <span className="ib-zsub ib-pmi-hint">This thread</span> : into ? <span className="ib-zsub ib-pmi-hint" dir="auto">{into}</span> : null}
    </Menu.Item>
  );
}
