/**
 * The list's picks (rowPicks.ts) wired to the list (InboxList.tsx): ⌘ or Ctrl and a click, Shift and a click, and
 * while picking any click on a row picks it instead of opening its thread (the row's own click never runs); the boxes
 * on the groups' headers; the bar in the header's place and a phone's sheet; Escape. Picking ends when the list shows
 * another scope (a project, a tag, a machine). Tidy… opens Tidy's popover on the picks (PickTidy.tsx), Combine… its
 * dialog (CombineDialog.tsx); a started Combine ends picking, its rows saying "Combining…" (useCombines.ts). The open
 * Archived group's rows are picked too, though Select all takes only the list's, and Tidy… only the picks not archived.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { inboxRowArchived, type InboxListGroupId, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { boxState, useRowPicks, type PickRules } from '../rowPicks';
import type { BulkWrites } from '../bulkWrites';
import { machineTakes, type MachinesModel } from '../machines';
import { inboxListPickShortcuts } from '../shortcuts/listPick.shortcuts';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { PickBar, PickBox, PickSheet, type PickActions } from './PickBar';
import { PickTidy } from './PickTidy';
import { CombineDialog } from './CombineDialog';

const NONE: readonly InboxListRow[] = [];

export interface ListPicksInput {
  sections: readonly InboxListSection[];
  /** A group's rows are drawn (open, or in List every group's but a folded Snoozed band). */
  isOpen: (group: InboxListGroupId) => boolean;
  /** The rows a view draws besides the open groups' (the Agents view: an open agent's shown rows); Select all picks these too. */
  drawn?: readonly string[] | null;
  body: RefObject<HTMLElement | null>;
  bulk?: BulkWrites;
  phone: boolean;
  /** Beside an open thread: Tidy… and Combine… go in the bar's ⋯. */
  narrow?: boolean;
  scope: string | null;
  machines?: MachinesModel;
  pinned?: ReadonlySet<string>;
  snoozes: boolean;
  snoozesOf?: (row: InboxListRow) => boolean;
  sectionOf: (threadId: string) => InboxListGroupId | null;
  /** The open Archived group's rows: picked like the list's, though Select all takes only the list's. */
  archived?: readonly InboxListRow[];
}

/** What a picked row's right-click menu needs (RowMenu.tsx). */
export interface MenuPicks {
  has: (threadId: string) => boolean;
  /** A row that can be picked: the live list's, or the open Archived group's. */
  takes: (threadId: string) => boolean;
  start: (threadId: string) => void;
  act: PickActions;
  /** Stop the Combine a row waits in (its menu's Stop combining). */
  stopCombine?: (threadId: string) => void;
  /** A row dropped on another (listDrops.tsx): today's Combine dialog with exactly these threads picked. Absent: no Combine here. */
  combineWith?: (threadIds: readonly string[]) => void;
  /** A dragged thread was dropped anywhere (threadDrag.ts `dropped`): picking ends, unless the drop opened Combine on them. */
  dropped?: () => void;
}

export function useListPicks(input: ListPicksInput) {
  const { sections, isOpen, body, bulk, phone, machines, pinned, snoozesOf, sectionOf } = input;
  const archived = input.archived ?? NONE;
  const archivedIds = useMemo(() => new Set(archived.map((row) => row.thread_id)), [archived]);
  const listed = useMemo(() => new Set([...sections.flatMap((section) => section.threads.map((row) => row.thread_id)), ...archivedIds]), [sections, archivedIds]);
  const picks = useRowPicks(useCallback((id: string) => listed.has(id), [listed]));
  const { leave: leavePicks } = picks;
  /**
   * Leaves picking (Done, Escape, an action that ends it). The bar goes with it, so focus that was on the bar, a
   * menu or nowhere moves to the list: the row after the last pick, else the first pick still drawn, else the first row.
   */
  const leave = useCallback(() => {
    const drawn = [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
    const picked = picksRef.current.picked;
    const last = drawn.reduce((at, id, i) => (picked.has(id) ? i : at), -1);
    const order = [...drawn.slice(last + 1).filter((id) => !picked.has(id)), ...drawn.filter((id) => picked.has(id))];
    leavePicks();
    setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body && !now.closest('[data-pick-bar], [data-pick-sheet], [role="menu"]')) return;
      const target = order.map((id) => body.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)).find(Boolean);
      (target ?? body.current?.querySelector<HTMLElement>('[data-thread-id]'))?.focus();
    });
  }, [body, leavePicks]);
  const scope = useRef(input.scope);
  useEffect(() => {
    if (input.scope === scope.current) return;
    scope.current = input.scope;
    leave();
  }, [input.scope, leave]);
  /** The rows as drawn that can be picked, for a Shift press's range. */
  const order = () => [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!).filter((id) => listed.has(id));
  const drawnIds = [...(input.drawn ?? []), ...sections.filter((section) => isOpen(section.id)).flatMap((section) => section.threads.map((row) => row.thread_id))];
  const rows = [...sections.flatMap((section) => section.threads), ...archived].filter((row, i, all) => picks.picked.has(row.thread_id) && all.findIndex((r) => r.thread_id === row.thread_id) === i);
  const rules: PickRules = {
    drawn: (row) => sectionOf(row.thread_id) ?? (archivedIds.has(row.thread_id) ? 'archived' : null),
    snoozes: (row) => snoozesOf?.(row) ?? true,
    starred: (row) => (pinned && (!machines || machineTakes(row, machines, 'star')) ? pinned.has(row.thread_id) : null),
    prioritizes: (row) => !machines || machineTakes(row, machines, 'priority'),
  };
  const [tidyAt, setTidyAt] = useState<HTMLElement | null>(null);
  const [combining, setCombining] = useState(false);
  // A drop opened the dialog (listDrops.tsx): its Cancel leaves picking too, as every drop ends the picks
  // (drag-system.html clears them after any drop); until it closes, the drop's own end leaves them for the dialog.
  const dropOpened = useRef(false);
  const combines = bulk?.combines;
  const tidyRows = rows.filter((row) => !inboxRowArchived(row));
  const act: PickActions | null = bulk
    ? {
        rows,
        rules,
        bulk,
        onGone: leave,
        snoozes: input.snoozes,
        narrow: input.narrow,
        // From a menu, the popover sits on the bar's ⋯ (the menu has closed), else on the bar.
        ...(tidyRows.length > 0 ? { tidy: (anchor: HTMLElement | null) => setTidyAt(anchor ?? body.current?.closest('.pn-inbox')?.querySelector<HTMLElement>('[data-pick-bar] [data-pick-menu="more"], [data-pick-sheet] [data-pick-menu="more"], [data-pick-bar]') ?? null) } : {}),
        ...(combines ? { combine: () => setCombining(true) } : {}),
      }
    : null;

  /** A click on a row, before the row hears it: a pick, when picking or with ⌘ / Ctrl or Shift. */
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!bulk || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[data-thread-id]');
    if (!row || !body.current?.contains(row) || event.target.closest('[data-pick-box]')) return;
    if (!listed.has(row.getAttribute('data-thread-id')!)) return;
    const toggle = event.metaKey || event.ctrlKey;
    if (!picks.on && !toggle && !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    picks.press(row.getAttribute('data-thread-id')!, event.shiftKey ? 'range' : 'toggle', order());
  };
  const onRowBox = useCallback((row: InboxListRow, event: ReactMouseEvent) => picksRef.current.press(row.thread_id, event.shiftKey ? 'range' : 'toggle', orderRef.current()), []);
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const orderRef = useRef(order);
  orderRef.current = order;

  useShortcutScope({
    scope: inboxListPickShortcuts,
    target: 'document',
    handlers: {
      leavePicks: {
        when: (event) => {
          if (!picks.on || event.defaultPrevented || isComposingKey(event) || modalOpen()) return false;
          const from = keyTarget(event);
          return !(from && (isEditableTarget(from) || inOverlay(from) || from.closest('[role="menu"], [role="listbox"], [aria-expanded="true"]')));
        },
        handle: () => leave(),
      },
    },
  });

  const groupBox = (section: InboxListSection, open: boolean) => {
    if (!picks.on || !open || !act) return null;
    const ids = section.threads.map((row) => row.thread_id);
    return <PickBox state={boxState(ids, picks.picked)} label={`Select all in ${section.label}`} onPick={() => picks.all(ids)} />;
  };
  const bar =
    picks.on && act ? (
      <>
        <PickBar act={act} all={boxState(drawnIds, picks.picked)} onAll={() => picks.all(drawnIds)} onDone={leave} phone={phone} />
        <PickTidy rows={tidyRows} machines={machines} anchor={tidyAt} phone={phone} onClose={() => setTidyAt(null)} />
        {combining && combines && (
          <CombineDialog
            rows={rows}
            machines={machines}
            onClose={() => {
              setCombining(false);
              if (dropOpened.current) leave();
              dropOpened.current = false;
            }}
            onStarted={(record, machine, label) => (combines.begin(record, machine, rows, label), leave())}
          />
        )}
      </>
    ) : null;
  const sheet = picks.on && act && phone ? <PickSheet act={act} /> : null;
  const stopCombine = combines ? (id: string) => combines.waiting.has(id) && void combines.stop(combines.waiting.get(id)!) : undefined;
  const combineWith = combines
    ? (ids: readonly string[]) => {
        dropOpened.current = true;
        picks.leave();
        picks.start();
        picks.all(ids.filter((id) => listed.has(id)));
        setCombining(true);
      }
    : undefined;
  const dropped = () => {
    if (!dropOpened.current && picksRef.current.on) leave();
  };
  const menu: MenuPicks | undefined = act ? { has: (id) => picks.on && picks.picked.has(id), takes: (id) => listed.has(id), start: picks.start, act, stopCombine, combineWith, dropped } : undefined;
  return { on: picks.on && !!act, has: (id: string) => picks.picked.has(id), start: act ? () => picks.start() : undefined, onClickCapture, onRowBox, groupBox, bar, sheet, menu };
}
