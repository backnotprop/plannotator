/**
 * The row menu's Mention in reply (approval "inbox-drag-threads", piece 1): the non-drag way to mention a thread, for
 * a keyboard (Shift+F10 or the menu key on a row), a screen reader and a phone (the row's sheet). With several rows
 * picked it reads "Mention 3 in reply". It is there only while a reply with words not sent yet is in play (the owner,
 * 2026-11-22): on a computer the thread open beside the list, else an open floating draft's window, which the item
 * names; on a phone the reply the person was writing in, named too. Not on the row of that reply's own thread.
 */
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { useInboxQueryClient } from '../data/client';
import { replyDraftHasWords } from '../data/queries/drafts';
import { knownMentionRef, mentionRefOf, noteMentionRefs } from '../data/threadMentionRefs';
import { replyDraftSaveEndedAt, replyDraftUnsaved } from '../replyDraft';
import { mentionInReply, mentionTarget } from '../threadMentions';
import { ThreadGlyph } from '../replyMentions';

export function MentionMenuItem({ rows, phone }: { rows: readonly InboxListRow[]; phone: boolean }) {
  const client = useInboxQueryClient();
  // A saved draft's words, as the drafts list holds them. None listed is not known while a save is on its way, or
  // when the list was asked for before the last save ended (it is read again just after): absent, and still remembered.
  const draftWords = (id: string) => {
    const has = replyDraftHasWords(client, id, replyDraftSaveEndedAt());
    return has === false && replyDraftUnsaved() ? null : has;
  };
  const aim = rows.length > 0 ? mentionTarget(phone, draftWords) : null;
  if (!aim) return null;
  const target = aim.thread;
  const others = rows.filter((row) => row.thread_id !== target);
  if (others.length === 0) return null;
  const label = rows.length > 1 ? `Mention ${formatCount(rows.length)} in reply` : 'Mention in reply';
  // A reply that is not the thread on screen (a phone's sheet, or a floating draft's window) is named.
  const into = aim.open ? null : (knownMentionRef(client, target)?.title ?? 'the reply you last wrote');
  return (
    <Menu.Item
      className="ib-pmi"
      label={label}
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
      {into ? <span className="ib-zsub ib-pmi-hint" dir="auto">{into}</span> : null}
    </Menu.Item>
  );
}
