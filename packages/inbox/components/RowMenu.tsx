import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { focusAfterSwap, SnoozeTimes, type SnoozeView } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { Icon, type IconName } from '../icons';
import { rowMenuActions, type RowMenuAction } from '../rowMenu';
import { useThreadTags } from '../threadTags';
import { AddTagItem, AddTagList } from './AddTagMenu';
import { useContextMenuTrigger } from './useContextMenuTrigger';
import { OpenBesideItem } from '../panes/OpenBesideItem';
import { BulkItems, WorkItems, runBulk } from './PickBar';
import { BulkTagList } from './BulkTags';
import type { MenuPicks } from './useListPicks';
import { bulkTargets } from '../rowPicks';
import { formatCount } from '@plannotator/core/inbox-format';
import { MentionMenuItem } from './MentionMenuItem';
import { hideKeysWords } from '../pulls/hiddenPulls';
import { useThreadRowDrag } from './useThreadRowDrag';
import type { BandMenuAction } from '../markAllRead';
import { ListDrops, RowDragHelp, THREAD_DRAG_HELP_ID, useRowsDraggable } from './listDrops';
export { useRowDragA11y } from './listDrops';

export interface ThreadRowMenuProps {
  className: string;
  /** Finds a listed row by its thread id (the menu is one for the whole list). */
  rowOf: (threadId: string) => InboxListRow | null;
  /** The group a listed row sits in on screen (a held list can draw a row where its state no longer puts it). */
  sectionOf?: (threadId: string) => InboxListGroupId | null;
  /** Mark read and Move back are offered (the list has the row's hover action). */
  canMarkRead: boolean;
  /** Snooze the row until a moment (approval "inbox-snooze"). Absent (an older Inbox keeps no snoozes): no item. */
  onSnooze?: (row: InboxListRow, until: string) => void;
  /** Whether this row can be snoozed (a linked machine on an older Inbox keeps no snoozes). Absent: every row can. */
  snoozesOf?: (row: InboxListRow) => boolean;
  /** H on a row (InboxList.tsx): each new request opens that row's menu at its Snooze times. */
  snoozeRequest?: { id: string; n: number } | null;
  /** The machine that must update before this row can be snoozed: Snooze stays, and says so. */
  snoozeBlockedOf?: (row: InboxListRow) => { name: string } | null;
  onSnoozeBlocked?: (row: InboxListRow) => void;
  /**
   * Whether a thread is pinned to the sidebar (approval "inbox-pinned-threads"): Pin thread or Unpin
   * thread leads the menu, in its own group. Absent (an older Inbox keeps no pins), or null for a row whose machine
   * takes no star from this one: no item.
   */
  pinnedOf?: (row: InboxListRow) => boolean | null;
  /** Whether Add to Priority or Remove from Priority is offered on a row whose machine is another one. Absent: every row. */
  prioritizesOf?: (row: InboxListRow) => boolean;
  /** A Mark read resolves false when its set-aside warning was cancelled (App.tsx `rowAction`; a drop on Quiet reads it). */
  onAction: (row: InboxListRow, action: RowMenuAction) => unknown;
  /** The row whose menu is open (its muted background), or null when it closes. */
  onTarget: (threadId: string | null) => void;
  /** No menu (the host gave no actions): the browser's own. */
  disabled?: boolean;
  /**
   * A thread is open, so the list holds still (held.ts): a row written from the menu stays in place, and
   * where focus goes when the thread closes is App's rule, not the menu's.
   */
  held: boolean;
  /** A phone: the menu (a held row's, or a right-click's) is a sheet from the bottom edge, the thread's name over it. */
  phone?: boolean;
  /**
   * Picking rows (rowPicks.ts): Select leads every row's menu, and a picked row's menu is the picks' own (Archive,
   * Snooze, then the bar's ⋯ items), acting on every picked row. Absent: neither.
   */
  picks?: MenuPicks;
  /**
   * The group bands' menu (markAllRead.ts): a right-click, a held finger or the menu key on a band opens Mark all as
   * read, Archive all and (on a band of open questions) Re-ask all for that band's threads, each where it has something to take. A band with neither, or none
   * of this (absent): the browser's own menu, and its click is the band's toggle as ever.
   */
  bands?: BandMenu;
  children: ReactNode;
}

export interface BandMenu {
  /** The items the band offers now, in order; none: no menu. */
  actionsOf: (sectionId: string) => readonly BandMenuAction[];
  /** The band's words (the sheet's title and the menu's name). */
  labelOf: (sectionId: string) => string;
  /** What a write changes on the band (its threads' ids): once it differs, the write has landed. */
  stateOf: (sectionId: string) => string;
  onAction: (sectionId: string, action: BandMenuAction) => void;
  /** The band's menu really opened (a right-click, the key, or a hold that lasted): never a press that only took the look. */
  onOpened?: (sectionId: string) => void;
}

const BAND_LABELS: Record<BandMenuAction, { label: string; icon: IconName }> = {
  read: { label: 'Mark all as read', icon: 'checkCircle' },
  archive: { label: 'Archive all', icon: 'archive' },
  reask: { label: 'Re-ask all', icon: 'refresh' },
};

/** A band's id in the menu (a thread's is its own `msg_…` id). */
const BAND = 'band:';
export const bandMenuId = (sectionId: string) => `${BAND}${sectionId}`;
const bandOf = (id: string | null): string | null => (id?.startsWith(BAND) ? id.slice(BAND.length) : null);

const LABELS: Record<RowMenuAction, { label: string; icon: IconName; iconClass?: string }> = {
  pin: { label: 'Star thread', icon: 'star' },
  unpin: { label: 'Unstar thread', icon: 'star', iconClass: 'ib-star-on' },
  'priority-add': { label: 'Add to Priority', icon: 'toTop' },
  'priority-remove': { label: 'Remove from Priority', icon: 'toBottom' },
  'copy-thread': { label: 'Copy thread', icon: 'stack' },
  'copy-link': { label: 'Copy link', icon: 'link' },
  'copy-id': { label: 'Copy thread ID', icon: 'hash' },
  snooze: { label: 'Snooze', icon: 'clock' },
  unsnooze: { label: 'Unsnooze', icon: 'inbox' },
  read: { label: 'Mark read', icon: 'checkCircle' },
  'mark-unread': { label: 'Mark unread', icon: 'envelope' },
  unread: { label: 'Move back', icon: 'inbox' },
  'hide-pulls': { label: 'Hide pull request', icon: 'eyeOff' },
  archive: { label: 'Archive', icon: 'archive' },
  unarchive: { label: 'Unarchive', icon: 'archive' },
};

/** The row a `contextmenu` event names: a wide or three-line row (its wrapper, `data-row`), or a phone's row. */
function rowElementOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest<HTMLElement>('[data-row]');
  if (wrapper) return wrapper.querySelector<HTMLElement>('[data-thread-id]');
  return target.closest<HTMLElement>('.ib-mrow[data-thread-id]');
}

/** A group's band (its header, the group's toggle) a `contextmenu` event lands on. */
function bandElementOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const band = target.closest<HTMLElement>('button.ib-band');
  return band?.parentElement?.matches('.ib-group[data-section-id]') ? band : null;
}

/**
 * The thread rows' right-click menu: one menu for the whole list (its body is
 * the trigger), aimed at the row the right-click (or the platform's
 * context-menu key, or Shift+F10, on a focused row) lands on. Pin thread (or
 * Unpin thread), Add to Priority (or Remove from Priority) and Add tag (its tags swap in place; in a tag's list, Remove from <tag> too) in their own group, then Copy thread, Copy link, Copy thread ID, then Snooze
 * (the menu swaps in place for its times), Mark read (or Mark unread, or Move back) and Archive where they apply.
 * Anywhere else in the list the browser's own menu shows. Opening it never
 * opens the thread or moves the selection. Escape, Tab and an item put focus
 * on the row (wherever focus was before the right-click); a write that takes
 * the row off screen puts it on the row now in its slot. On a touch screen a finger held on a row opens it
 * (`useContextMenuTrigger`'s `longPress`): a sheet from the bottom edge on a phone, the menu under the row elsewhere.
 * The look is the project menu's (`.ib-pm`); the trigger's rules are
 * `useContextMenuTrigger`'s, shared with the Board's card menu.
 */
export const ThreadRowMenu = forwardRef<HTMLDivElement, ThreadRowMenuProps>(function ThreadRowMenu(props, ref) {
  const body = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => body.current!, []);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  /** A row's own button now (it may have been drawn again while the menu was open). */
  const buttonFor = (id: string): HTMLElement | null => {
    const band = bandOf(id);
    if (band !== null) return body.current?.querySelector<HTMLElement>(`.ib-group[data-section-id="${CSS.escape(band)}"] > button.ib-band`) ?? null;
    return body.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`) ?? null;
  };
  const rowOrder = () => [...(body.current?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
  const bandOrder = () => [...(body.current?.querySelectorAll('.ib-group[data-section-id] > button.ib-band') ?? [])].map((el) => bandMenuId(el.parentElement!.getAttribute('data-section-id')!));
  const firstBand = () => body.current?.querySelector<HTMLElement>('button.ib-band') ?? null;
  const bands = props.bands;
  const menu = useContextMenuTrigger({
    // A row, else (with `bands`) a group's band.
    itemOf: (target) => rowElementOf(target) ?? (bands ? bandElementOf(target) : null),
    idOf: (button) => button.getAttribute('data-thread-id') ?? (button.matches('button.ib-band') ? bandMenuId(button.parentElement!.getAttribute('data-section-id')!) : null),
    has: (id) => {
      const band = bandOf(id);
      return band !== null ? (bands?.actionsOf(band).length ?? 0) > 0 : props.rowOf(id) !== null;
    },
    buttonFor,
    // A row that left the rows on screen: the row now in its slot, else the first band. A band that left: the band now
    // in its slot.
    slotOf: (id) => ({ order: bandOf(id) !== null ? bandOrder() : rowOrder(), fallback: firstBand }),
    // What a write (Mark read, Mark unread, Move back, Archive, Remove from) changes on a row: once it differs, the write has landed.
    stateOf: (id) => {
      const band = bandOf(id);
      if (band !== null) return bands?.stateOf(band) ?? '';
      const row = props.rowOf(id);
      return row ? `${row.section}|${row.unread}|${row.read_at ?? ''}|${row.resolved_at ?? ''}|${row.snoozed?.until ?? ''}|${row.priority ? 'p' : ''}|${row.tags?.join(',') ?? ''}` : '';
    },
    disabled: props.disabled,
    held: props.held,
    onTarget: props.onTarget,
    longPress: true,
  });
  // A band's menu, or a row's.
  const bandTarget = bandOf(menu.targetId);
  const bandOpen = menu.open && bandTarget !== null ? bandTarget : null;
  useEffect(() => {
    if (bandOpen !== null) bands?.onOpened?.(bandOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandOpen]);
  const bandActions = bandTarget !== null && bands ? bands.actionsOf(bandTarget) : [];
  const target = menu.targetId && bandTarget === null ? props.rowOf(menu.targetId) : null;
  // A row pressed with a mouse and moved is dragged (threadDrag.ts): into the reply box, a mention; to the list's top or
  // bottom edge or held on another row, the places ListDrops draws while it is carried.
  const draggable = useRowsDraggable();
  const dragOff = props.disabled === true || props.phone === true || !draggable;
  const pressRow = useThreadRowDrag({ body, rowOf: props.rowOf, picks: props.picks, off: dragOff });
  const actions = target ? rowMenuActions(target, props.canMarkRead, props.pinnedOf ? props.pinnedOf(target) : null, props.sectionOf?.(target.thread_id) ?? null, props.onSnooze !== undefined && ((props.snoozesOf?.(target) ?? true) || !!props.snoozeBlockedOf?.(target)), props.prioritizesOf?.(target) ?? true) : [];
  const snoozeBlocked = target ? (props.snoozeBlockedOf?.(target) ?? null) : null;
  // A picked row: the menu is the picks' (acting on every picked row).
  const picked = target && props.picks?.has(target.thread_id) ? props.picks : null;
  const pinning = actions.filter((a) => a === 'pin' || a === 'unpin' || a === 'priority-add' || a === 'priority-remove');
  const copies = actions.filter((a) => a === 'copy-thread' || a === 'copy-link' || a === 'copy-id');
  const writes = actions.filter((a) => a === 'snooze' || a === 'unsnooze' || a === 'read' || a === 'mark-unread' || a === 'unread' || a === 'hide-pulls' || a === 'archive' || a === 'unarchive');
  // Snooze swaps the menu in place for its times (approval "inbox-snooze"), and Add tag for its tags; the next menu
  // opens as the menu again.
  const [snoozeView, setSnoozeView] = useState<SnoozeView | null>(null);
  const shownView = target ? snoozeView : null;
  const [tagView, setTagView] = useState(false);
  const shownTags = !!target && tagView;
  useLayoutEffect(() => {
    if (menu.open) return;
    setSnoozeView(null);
    setTagView(false);
  }, [menu.open]);
  // Back from a swapped-in list: focus goes to the item that opened it, not to the item now at its old index.
  const backed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (shownView !== null || shownTags || !backed.current) return;
    const item = backed.current;
    backed.current = null;
    return focusAfterSwap(() => document.querySelector<HTMLElement>(`[data-row-menu="${target?.thread_id ?? ''}"] ${item}`));
  }, [shownView, shownTags, target?.thread_id]);
  const tags = useThreadTags();
  // In a tag's list (approval "inbox-thread-tags"), a row in it offers Remove from <tag>.
  const listed = tags?.listed ?? null;
  const removable = target && listed && tags?.tagsOf(target.thread_id).includes(listed.id) ? listed : null;
  // H: the row's menu, opened as Shift+F10 opens it (a `contextmenu` at the row), straight at the times.
  // Only a new request opens it, and the times show only when the menu took the `contextmenu` (Base UI cancels the
  // one it opens on): a row the trigger refuses leaves the next right-click at the menu.
  const request = props.snoozeRequest;
  const seenRequest = useRef(request?.n ?? 0);
  useEffect(() => {
    if (!request || request.n === seenRequest.current) return;
    seenRequest.current = request.n;
    const button = buttonFor(request.id);
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const opened = !button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 24, clientY: rect.bottom }));
    if (opened) setSnoozeView('times');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, request?.n]);
  // Hide pull request names how many (and "merge request" on GitLab).
  const labelOf = (action: RowMenuAction) => (action === 'hide-pulls' && target ? hideKeysWords(target.hide_pulls ?? []) : LABELS[action].label);
  const item = (action: RowMenuAction) =>
    action === 'snooze' && snoozeBlocked ? (
      <Menu.Item key={action} className="ib-pmi" label={`Snooze: update ${snoozeBlocked.name} first`} data-row-action="snooze" data-snooze-blocked="" onClick={() => target && props.onSnoozeBlocked?.(target)}>
        <Icon name="clock" size={15} />
        {LABELS.snooze.label}
        <span className="ib-zsub ib-zneeds">Update {snoozeBlocked.name}</span>
      </Menu.Item>
    ) : action === 'snooze' ? (
      <Menu.Item key={action} className="ib-pmi" label={LABELS.snooze.label} closeOnClick={false} data-row-action="snooze" onClick={() => setSnoozeView('times')}>
        <Icon name="clock" size={15} />
        {LABELS.snooze.label}
        <span className="ib-zsub">
          <Icon name="chevR" size={13} />
        </span>
      </Menu.Item>
    ) : (
      <Menu.Item
        key={action}
        className="ib-pmi"
        label={labelOf(action)}
        data-row-action={action}
        onClick={() => {
          if (!target) return;
          // With a thread open the row stays in place: nothing to follow (`held`). A pin never moves a row; Priority
          // moves it even then, as a snooze does (App.tsx `movePriorityRow`).
          if (action === 'priority-add' || action === 'priority-remove') menu.follow(target.thread_id, true);
          else if (action !== 'copy-thread' && action !== 'copy-link' && action !== 'copy-id' && action !== 'pin' && action !== 'unpin') menu.follow(target.thread_id);
          props.onAction(target, action);
        }}
      >
        <Icon name={LABELS[action].icon} size={15} className={LABELS[action].iconClass} />
        {labelOf(action)}
      </Menu.Item>
    );
  return (
    <ContextMenu.Root {...menu.root}>
      {/* Buttons and the empty list's link keep the platform's own long-press callout (the hook's `style`). */}
      <ContextMenu.Trigger ref={body} className={props.className} {...menu.trigger} onPointerDown={(event) => {
          menu.trigger.onPointerDown?.(event);
          pressRow(event);
        }}>
        <RowDragHelp.Provider value={dragOff ? null : THREAD_DRAG_HELP_ID}>{props.children}</RowDragHelp.Provider>
      </ContextMenu.Trigger>
      <ListDrops body={body} rowOf={props.rowOf} sectionOf={props.sectionOf} canMarkRead={props.canMarkRead} prioritizesOf={props.prioritizesOf} onAction={props.onAction} picks={props.picks} follow={menu.follow} off={dragOff} />
      <ContextMenu.Portal container={portal ?? undefined}>
        {props.phone && <ContextMenu.Backdrop className="ib-pm-scrim" />}
        <ContextMenu.Positioner className="ib-pm-pos" data-phone={props.phone ? '' : undefined}>
          <ContextMenu.Popup
            className="ib-pm"
            aria-label={bandTarget !== null ? (bands?.labelOf(bandTarget) ?? 'Group') : picked ? pickedTitle(picked.act.rows.length) : (target?.subject ?? 'Thread')}
            data-row-menu={target?.thread_id}
            data-band-menu={bandTarget ?? undefined}
            data-picked-menu={picked ? '' : undefined}
            {...menu.popup}
          >
            {/* The popup is named already (aria-label): the title is for the eye only, on a phone's sheet (the thread's ⋯ sheet's). */}
            {bandTarget !== null && bands && (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {bands.labelOf(bandTarget)}
                </div>
                {bandActions.map((action) => (
                  <Menu.Item
                    key={action}
                    className="ib-pmi"
                    label={BAND_LABELS[action].label}
                    data-band-action={action}
                    onClick={() => {
                      // The band may leave once its threads settle elsewhere: focus that fell to the page goes to the band in its slot.
                      menu.follow(bandMenuId(bandTarget));
                      bands.onAction(bandTarget, action);
                    }}
                  >
                    <Icon name={BAND_LABELS[action].icon} size={15} />
                    {BAND_LABELS[action].label}
                  </Menu.Item>
                ))}
              </>
            )}
            {target && (
              <div className="ib-pm-title" dir="auto" aria-hidden="true">
                {picked ? pickedTitle(picked.act.rows.length) : (target.subject ?? '(no subject)')}
              </div>
            )}
            {picked ? (
              shownView ? (
                <SnoozeTimes view={shownView} onView={setSnoozeView} onBack={() => setSnoozeView(null)} onPick={(until) => runBulk(picked.act, 'snooze', until)} onClose={menu.close} />
              ) : shownTags ? (
                <BulkTagList threadIds={picked.act.rows.map((row) => row.thread_id)} onBack={() => setTagView(false)} />
              ) : (
                <>
                  <WorkItems act={picked.act} anchor={() => (target ? body.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(target.thread_id)}"]`) ?? null : null)} />
                  {bulkTargets(picked.act.rows, 'archive', picked.act.rules).length > 0 && (
                    <Menu.Item className="ib-pmi" label="Archive" data-bulk-action="archive" onClick={() => runBulk(picked.act, 'archive')}>
                      <Icon name="archive" size={15} />
                      Archive
                    </Menu.Item>
                  )}
                  {picked.act.snoozes && bulkTargets(picked.act.rows, 'snooze', picked.act.rules).length > 0 && (
                    <Menu.Item className="ib-pmi" label="Snooze" closeOnClick={false} data-bulk-action="snooze" onClick={() => setSnoozeView('times')}>
                      <Icon name="clock" size={15} />
                      Snooze
                      <span className="ib-zsub">
                        <Icon name="chevR" size={13} />
                      </span>
                    </Menu.Item>
                  )}
                  <Menu.Separator className="ib-pm-sep" />
                  <BulkItems act={picked.act} onTags={() => setTagView(true)} />
                </>
              )
            ) : shownView && target ? (
              <SnoozeTimes
                view={shownView}
                onView={setSnoozeView}
                onBack={() => {
                  backed.current = '[data-row-action="snooze"]';
                  setSnoozeView(null);
                }}
                onPick={(until) => {
                  // A snooze moves its row even while a thread is open (App.tsx `moveSnoozedRow`): focus follows it.
                  menu.follow(target.thread_id, true);
                  props.onSnooze?.(target, until);
                }}
                onClose={menu.close}
              />
            ) : shownTags && target ? (
              <AddTagList
                threadId={target.thread_id}
                onBack={() => {
                  backed.current = '[data-add-tag-item]';
                  setTagView(false);
                }}
              />
            ) : (
              <>
                {target && <OpenBesideItem threadId={target.thread_id} />}
                {/* Select first, alone (approval "inbox-multi-select", 1B): picking starts with this row picked. */}
                {target && props.picks?.takes(target.thread_id) && (
                  <>
                    <Menu.Item className="ib-pmi" label="Select" data-row-action="select" onClick={() => props.picks!.start(target.thread_id)}>
                      <Icon name="todoOpen" size={15} />
                      Select
                    </Menu.Item>
                    <Menu.Separator className="ib-pm-sep" />
                  </>
                )}
                {target?.combining && props.picks?.stopCombine && (
                  <>
                    <Menu.Item className="ib-pmi" label="Stop combining" data-row-action="stop-combine" onClick={() => props.picks!.stopCombine!(target.thread_id)}>
                      <Icon name="xCircle" size={15} />
                      Stop combining
                    </Menu.Item>
                    <Menu.Separator className="ib-pm-sep" />
                  </>
                )}
                {/* Pin thread first, then Add to Priority, then Add tag (and Remove from, in a tag's list), in their own group. */}
                {pinning.map(item)}
                {target && <AddTagItem threadId={target.thread_id} onOpen={() => setTagView(true)} />}
                {removable && target && (
                  <Menu.Item className="ib-pmi" label={`Remove from ${removable.name}`} onClick={() => {
                      // Out of the tag's list: focus goes to the row now in its slot.
                      menu.follow(target.thread_id);
                      tags?.set(target.thread_id, removable, false);
                    }} data-tag-remove={removable.id}>
                    <Icon name="minus" size={15} />
                    <span className="ib-tagm-l" dir="auto">
                      Remove from {removable.name}
                    </span>
                  </Menu.Item>
                )}
                {(pinning.length > 0 || (target && tags?.can(target.thread_id))) && <Menu.Separator className="ib-pm-sep" />}
                {/* Mention in reply (approval "inbox-drag-threads"): first in the group on a phone's sheet, last on a computer. */}
                {props.phone && target && <MentionMenuItem rows={[target]} phone />}
                {copies.map(item)}
                {!props.phone && target && <MentionMenuItem rows={[target]} phone={false} />}
                {writes.length > 0 && <Menu.Separator className="ib-pm-sep" />}
                {writes.map(item)}
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

/** A picked row's menu title: "3 selected threads". */
const pickedTitle = (n: number) => `${formatCount(n)} selected ${n === 1 ? 'thread' : 'threads'}`;
