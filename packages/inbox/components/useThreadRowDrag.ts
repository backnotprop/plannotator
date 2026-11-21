/**
 * The thread list's rows as a drag source (threadDrag.ts, approval "inbox-drag-threads"): one listener on the list's
 * body, so no row shape needs its own. A mouse or pen press on a row may become a drag once it moves; a picked row
 * carries every picked row (⌘-click or Shift-click picks them, as before). A phone never drags.
 */
import { useCallback, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { pressThreadRow } from '../threadDrag';
import { mentionRefOf, mentionTitleOf, noteMentionRefs } from '../data/threadMentionRefs';
import type { MenuPicks } from './useListPicks';

/** The row a press lands on: its button (a wide or three-line row's wrapper holds it, `data-row`). */
function rowButtonOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const own = target.closest<HTMLElement>('[data-thread-id]');
  if (own) return own;
  return target.closest<HTMLElement>('[data-row]')?.querySelector<HTMLElement>('[data-thread-id]') ?? null;
}

export function useThreadRowDrag({ body, rowOf, picks, off }: { body: RefObject<HTMLElement | null>; rowOf: (id: string) => InboxListRow | null; picks?: MenuPicks; off: boolean }) {
  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (off || event.button !== 0 || event.pointerType === 'touch') return;
      const list = body.current;
      const button = rowButtonOf(event.target);
      if (!list || !button || !list.contains(button)) return;
      // A control inside a row (a star, a menu button) keeps its own press.
      if (event.target instanceof Element && event.target.closest('a[href], input, [data-star-press]')) return;
      const id = button.getAttribute('data-thread-id');
      if (!id || !rowOf(id)) return;
      const root = list.closest<HTMLElement>('.pn-inbox') ?? list.ownerDocument.body;
      pressThreadRow(
        event.nativeEvent,
        {
          ids: () => {
            const picked = picks?.has(id) ? picks.act.rows.map((row) => row.thread_id) : [];
            const ids = picked.length > 1 ? picked : [id];
            // What the drop names (an Archived group's row is in no list read).
            noteMentionRefs(ids.flatMap((one) => {
              const row = rowOf(one);
              return row ? [mentionRefOf(row)] : [];
            }));
            return ids;
          },
          label: (ids) => (ids.length > 1 ? `${formatCount(ids.length)} threads` : mentionTitleOf(rowOf(ids[0]!) ?? { thread_name: null, subject: null })),
          rows: (ids) => ids.flatMap((one) => [...list.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(one)}"]`)]),
          scroller: () => list,
          // Any drop ends the picks (drag-system.html), as the pick bar's Done does.
          dropped: () => picks?.dropped?.(),
          spoken: (ids) => (ids.length > 1 ? `Picked up ${formatCount(ids.length)} threads.` : `Picked up ${mentionTitleOf(rowOf(ids[0]!) ?? { thread_name: null, subject: null })}.`),
        },
        root,
      );
    },
    [body, rowOf, picks, off],
  );
}
