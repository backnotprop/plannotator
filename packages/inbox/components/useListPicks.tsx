/**
 * The list's picks (rowPicks.ts) wired to the list (InboxList.tsx): ⌘ or Ctrl and a click, Shift and a click, and
 * while picking any click on a row picks it instead of opening its thread (the row's own click never runs); the boxes
 * on the groups' headers; the bar in the header's place and a phone's sheet; Escape. Picking ends when the list shows
 * another scope (a project, a tag, a machine).
 */
import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { boxState, useRowPicks, type PickRules } from '../rowPicks';
import type { BulkWrites } from '../bulkWrites';
import { machineTakes, type MachinesModel } from '../machines';
import { inboxListPickShortcuts } from '../shortcuts/listPick.shortcuts';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { PickBar, PickBox, PickSheet, type PickActions } from './PickBar';

export interface ListPicksInput {
  sections: readonly InboxListSection[];
  /** A group's rows are drawn (open, or in List every group's but a folded Snoozed band). */
  isOpen: (group: InboxListGroupId) => boolean;
  body: RefObject<HTMLElement | null>;
  bulk?: BulkWrites;
  phone: boolean;
  scope: string | null;
  machines?: MachinesModel;
  pinned?: ReadonlySet<string>;
  snoozes: boolean;
  snoozesOf?: (row: InboxListRow) => boolean;
  sectionOf: (threadId: string) => InboxListGroupId | null;
}

/** What a picked row's right-click menu needs (RowMenu.tsx). */
export interface MenuPicks {
  has: (threadId: string) => boolean;
  start: (threadId: string) => void;
  act: PickActions;
}

export function useListPicks(input: ListPicksInput) {
  const { sections, isOpen, body, bulk, phone, machines, pinned, snoozesOf, sectionOf } = input;
  const listed = useMemo(() => new Set(sections.flatMap((section) => section.threads.map((row) => row.thread_id))), [sections]);
  const picks = useRowPicks(useCallback((id: string) => listed.has(id), [listed]));
  const { leave } = picks;
  const scope = useRef(input.scope);
  useEffect(() => {
    if (input.scope === scope.current) return;
    scope.current = input.scope;
    leave();
  }, [input.scope, leave]);
  /** The rows as drawn, for a Shift press's range. */
  const order = () => [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
  const drawnIds = sections.filter((section) => isOpen(section.id)).flatMap((section) => section.threads.map((row) => row.thread_id));
  const rows = sections.flatMap((section) => section.threads).filter((row, i, all) => picks.picked.has(row.thread_id) && all.findIndex((r) => r.thread_id === row.thread_id) === i);
  const rules: PickRules = {
    drawn: (row) => sectionOf(row.thread_id),
    snoozes: (row) => snoozesOf?.(row) ?? true,
    starred: (row) => (pinned && (!machines || machineTakes(row, machines, 'star')) ? pinned.has(row.thread_id) : null),
    prioritizes: (row) => !machines || machineTakes(row, machines, 'priority'),
  };
  const act: PickActions | null = bulk ? { rows, rules, bulk, onGone: leave, snoozes: input.snoozes } : null;

  /** A click on a row, before the row hears it: a pick, when picking or with ⌘ / Ctrl or Shift. */
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!bulk || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[data-thread-id]');
    if (!row || !body.current?.contains(row) || event.target.closest('[data-pick-box]')) return;
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
        handle: () => {
          // Focus on the bar, which goes with picking: to the first picked row, else the list's first row.
          const lost = !!document.activeElement?.closest('[data-pick-bar], [data-pick-sheet]');
          const first = [...picks.picked][0];
          leave();
          if (lost) setTimeout(() => (body.current?.querySelector<HTMLElement>(first ? `[data-thread-id="${CSS.escape(first)}"]` : '[data-thread-id]') ?? null)?.focus());
        },
      },
    },
  });

  const groupBox = (section: InboxListSection, open: boolean) => {
    if (!picks.on || !open || !act) return null;
    const ids = section.threads.map((row) => row.thread_id);
    return <PickBox state={boxState(ids, picks.picked)} label={`Select all in ${section.label}`} onPick={() => picks.all(ids)} />;
  };
  const bar = picks.on && act ? <PickBar act={act} all={boxState(drawnIds, picks.picked)} onAll={() => picks.all(drawnIds)} onDone={leave} phone={phone} /> : null;
  const sheet = picks.on && act && phone ? <PickSheet act={act} /> : null;
  const menu: MenuPicks | undefined = act ? { has: (id) => picks.on && picks.picked.has(id), start: picks.start, act } : undefined;
  return { on: picks.on && !!act, has: (id: string) => picks.picked.has(id), start: act ? () => picks.start() : undefined, onClickCapture, onRowBox, groupBox, bar, sheet, menu };
}
