/**
 * Picking thread rows (approval "inbox-multi-select", 1B + 2A; rowPicks.ts): the box a row, a group or the whole list
 * is picked with, the bar that stands in for the list's header while picking ("3 selected", Archive, Snooze, Mark read,
 * Tidy…, Combine…, ⋯, Done; beside an open thread, or where the column has no room for the line, Mark read is in the
 * ⋯, and beside an open thread Tidy… and Combine… are its first items),
 * a phone's sheet of the same actions at the bottom edge, and the items the bar's ⋯ and a picked row's menu share.
 * Every action takes the picked rows it applies to (rowPicks.ts `bulkTargets`), with one toast and one Undo
 * (bulkWrites.ts). In a narrow list (beside an open thread) the bar keeps one line: a count of 100 or more draws
 * Archive and Snooze as their icons, named for a screen reader.
 */
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { SnoozeTimes, type SnoozeView } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { Icon, type IconName } from '../icons';
import { bulkTargets, offersPicksReask, type BoxState, type BulkAction, type PickRules } from '../rowPicks';
import type { BulkWrites } from '../bulkWrites';
import { useToastAbove } from '../toastAbove';
import { BulkTagList, useBulkTagsShown } from './BulkTags';
import { TagIcon } from './InitiativePeek';
import { Tip } from './Tip';
import { MentionMenuItem } from './MentionMenuItem';
import { isPhone } from '../phone';
import { hideKeysWords } from '../pulls/hiddenPulls';

/** Combine… with one thread picked: greyed, and its tooltip says why. */
export const COMBINE_NEEDS_TWO = 'Pick two or more threads to combine';

/** A box that picks: a row's, a group's, or the whole list's (half filled while only some of it is picked). */
export function PickBox({ state, label, onPick, row }: { state: BoxState; label: string; onPick: (event: ReactMouseEvent) => void; row?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      className="ib-pick-box"
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      aria-label={label}
      data-on={state === 'none' ? undefined : ''}
      // A row's box is the pointer's: the row itself (aria-pressed) is the keyboard's, so Tab does not stop twice.
      tabIndex={row ? -1 : undefined}
      data-pick-box={row ? 'row' : ''}
      onClick={(event) => {
        event.stopPropagation();
        onPick(event);
      }}
    >
      {state === 'some' ? (
        <svg className="ib-ic" viewBox="0 0 24 24" width={12} height={12} aria-hidden="true" focusable="false">
          <path d="M6 12h12" />
        </svg>
      ) : (
        <Icon name="check" size={12} />
      )}
    </button>
  );
}

/** The mark inside a phone's row: the row is what a tap picks, so this is only its picture. */
export function PickMark({ on }: { on: boolean }) {
  return (
    <span className="ib-pick-box ib-pick-mark" data-on={on ? '' : undefined} aria-hidden="true">
      <Icon name="check" size={12} />
    </span>
  );
}

/** The Inbox's root, which menus portal into (as the list's ⋮). */
function usePortal(anchor: React.RefObject<HTMLElement | null>): HTMLElement | null {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), [anchor]);
  return portal;
}

export interface PickActions {
  rows: readonly InboxListRow[];
  rules: PickRules;
  bulk: BulkWrites;
  /** The rows left the list (Archive, Snooze): picking ends. */
  onGone: () => void;
  /** Snooze is offered (an Inbox that keeps snoozes). */
  snoozes: boolean;
  /** Tidy… on the picks, its popover at `anchor` (null: the bar's Tidy…, else its ⋯). */
  tidy?: (anchor: HTMLElement | null) => void;
  /** Combine… on the picks (two or more). */
  combine?: () => void;
  /** Beside an open thread: the bar's Tidy… and Combine… are the ⋯'s first items. */
  narrow?: boolean;
}

/** Tidy… and Combine… as menu items (the narrow bar's ⋯, a picked row's menu), then a separator. */
export function WorkItems({ act, anchor }: { act: PickActions; anchor?: () => HTMLElement | null }) {
  if (!act.tidy && !act.combine) return null;
  const two = act.rows.length >= 2;
  return (
    <>
      {act.tidy && (
        <Menu.Item className="ib-pmi" label="Tidy…" onClick={() => act.tidy!(anchor?.() ?? null)} data-pick-work="tidy">
          <Icon name="brush" size={15} />
          Tidy…
        </Menu.Item>
      )}
      {act.combine && (
        <Menu.Item className="ib-pmi" label="Combine…" disabled={!two} onClick={() => act.combine!()} data-pick-work="combine" title={two ? undefined : COMBINE_NEEDS_TWO}>
          <Icon name="swap" size={15} />
          Combine…
        </Menu.Item>
      )}
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
}

const ITEMS: { action: BulkAction; label: string; icon: IconName; iconClass?: string }[] = [
  { action: 'read', label: 'Mark read', icon: 'checkCircle' },
  { action: 'reask', label: 'Re-ask', icon: 'refresh' },
  { action: 'unread', label: 'Mark unread', icon: 'envelope' },
  { action: 'star', label: 'Star threads', icon: 'star' },
  { action: 'unstar', label: 'Unstar threads', icon: 'star', iconClass: 'ib-star-on' },
  { action: 'priority-add', label: 'Add to Priority', icon: 'toTop' },
  { action: 'priority-remove', label: 'Remove from Priority', icon: 'toBottom' },
  { action: 'hide-pulls', label: 'Hide pull requests', icon: 'eyeOff' },
];

/** Runs one action on the rows it takes. Mark read gives its answer: false when its warning was cancelled. */
export function runBulk(act: PickActions, action: BulkAction, until?: string): Promise<boolean> | void {
  const rows = bulkTargets(act.rows, action, act.rules);
  if (rows.length === 0) return;
  const { bulk } = act;
  if (action === 'archive') void bulk.archive(rows);
  else if (action === 'snooze' && until) void bulk.snooze(rows, until);
  else if (action === 'read') return bulk.markRead(rows);
  else if (action === 'reask') void bulk.reaskAll(rows);
  else if (action === 'unread') void bulk.markUnread(rows);
  else if (action === 'star' || action === 'unstar') void bulk.star(rows, action === 'star');
  else if (action === 'priority-add' || action === 'priority-remove') void bulk.priority(rows, action === 'priority-add');
  else if (action === 'hide-pulls') void bulk.hidePulls(rows);
  if (action === 'archive' || action === 'snooze' || action === 'hide-pulls') act.onGone();
}

/**
 * The ⋯'s items (and a picked row's menu's, after Archive and Snooze): Mark read, Re-ask, Mark unread, Star or Unstar,
 * Add to or Remove from Priority, then Add tag. An item no picked row takes is not offered; Star shows while any picked row
 * is not starred, Unstar once all are.
 */
export function BulkItems({ act, onTags, skip }: { act: PickActions; onTags: () => void; skip?: BulkAction }) {
  const has = (action: BulkAction) => bulkTargets(act.rows, action, act.rules).length > 0;
  const shown = ITEMS.filter(({ action }) => action !== skip).filter(({ action }) =>
    action === 'unstar' ? !has('star') && has('unstar') : action === 'priority-remove' ? !has('priority-add') && has('priority-remove') : action === 'reask' ? offersPicksReask(act.rows, act.rules) : has(action),
  );
  const tags = useBulkTagsShown(act.rows);
  return (
    <>
      {/* Mention 3 in reply (approval "inbox-drag-threads"): the picked rows, in the reply on screen. */}
      <MentionMenuItem rows={act.rows} phone={isPhone()} />
      {shown.map(({ action, label: fixed, icon, iconClass }) => {
        // Hide names the PRs it takes: "Hide pull request", "Hide 4 pull requests".
        const label = action === 'hide-pulls' ? hideKeysWords([...new Set(bulkTargets(act.rows, action, act.rules).flatMap((row) => row.hide_pulls ?? []))]) : fixed;
        return (
          <Menu.Item key={action} className="ib-pmi" label={label} data-bulk-action={action} onClick={() => runBulk(act, action)}>
            <Icon name={icon} size={15} className={iconClass} />
            {label}
          </Menu.Item>
        );
      })}
      {tags && shown.length > 0 && <Menu.Separator className="ib-pm-sep" />}
      {tags && (
        <Menu.Item className="ib-pmi" label="Add tag" closeOnClick={false} onClick={onTags} data-add-tag-item="">
          <TagIcon size={15} />
          Add tag
          <span className="ib-zsub">
            <Icon name="chevR" size={13} />
          </span>
        </Menu.Item>
      )}
    </>
  );
}

/** A menu from a bar button: Snooze's times, or the ⋯'s items (Add tag's list swaps in place). */
function BarMenu({ kind, act, phone, trigger, label, className, skip }: { kind: 'snooze' | 'more'; act: PickActions; phone: boolean; trigger: ReactNode; label: string; className: string; skip?: BulkAction }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const portal = usePortal(anchor);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SnoozeView>('times');
  const [tags, setTags] = useState(false);
  const n = act.rows.length;
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setView('times');
          setTags(false);
        }
      }}
      modal={false}
    >
      <Menu.Trigger ref={anchor} className={className} aria-label={label} data-pick-menu={kind}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side={phone ? 'top' : 'bottom'} align={kind === 'more' ? 'end' : 'start'} sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm" aria-label={kind === 'snooze' ? `Snooze ${n === 1 ? '1 thread' : `${formatCount(n)} threads`}` : `${formatCount(n)} selected`} data-pick-popup={kind}>
            {kind === 'snooze' ? (
              <>
                {phone && <div className="ib-pm-title" aria-hidden="true">{`Snooze ${n === 1 ? '1 thread' : `${formatCount(n)} threads`}`}</div>}
                <SnoozeTimes view={view} onView={setView} onPick={(until) => runBulk(act, 'snooze', until)} onClose={() => setOpen(false)} />
              </>
            ) : tags ? (
              <BulkTagList threadIds={act.rows.map((row) => row.thread_id)} onBack={() => setTags(false)} />
            ) : (
              <>
                {phone && <div className="ib-pm-title" aria-hidden="true">{n === 1 ? '1 thread' : `${formatCount(n)} threads`}</div>}
                {act.narrow && !phone && <WorkItems act={act} anchor={() => anchor.current} />}
                <BulkItems act={act} onTags={() => setTags(true)} skip={skip} />
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface PickBarProps {
  act: PickActions;
  /** The box over every row drawn. */
  all: BoxState;
  onAll: () => void;
  onDone: () => void;
  phone: boolean;
}

/**
 * Whether the wide bar has room for Mark read as its own button, measured: a list column too narrow for the whole
 * line (the sidebar open in a window under about 930 px) would cut the count under the buttons or push Done out, so
 * Mark read goes back into the ⋯ then, and comes out again once the bar is as wide as the line needed. The bar never
 * takes two lines.
 */
function useBarRoom(wanted: boolean, count: number): { ref: RefObject<HTMLDivElement | null>; fits: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  /** The width the line needed with Mark read in it, once it did not fit; null while it fits. */
  const [needs, setNeeds] = useState<number | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || !wanted) return;
    const check = () => {
      if (needs === null) {
        // Short of room: the line runs past the bar, or the count (which may shrink) is cut under the buttons.
        const count = bar.querySelector<HTMLElement>('.ib-pick-n');
        const short = Math.max(0, bar.scrollWidth - bar.clientWidth) + (count ? Math.max(0, count.scrollWidth - count.clientWidth) : 0);
        if (short > 1) setNeeds(bar.clientWidth + short);
      } else if (bar.clientWidth >= needs) setNeeds(null);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(check);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [wanted, needs, count]);
  return { ref, fits: needs === null };
}

/** The bar in the list header's place while picking (2A). */
export function PickBar({ act, all, onAll, onDone, phone }: PickBarProps) {
  const n = act.rows.length;
  const archives = bulkTargets(act.rows, 'archive', act.rules).length > 0;
  const snoozes = act.snoozes && bulkTargets(act.rows, 'snooze', act.rules).length > 0;
  // Mark read is the bar's own button where there is room (not beside an open thread), and so not in its ⋯.
  const wantsRead = !act.narrow && bulkTargets(act.rows, 'read', act.rules).length > 0;
  const room = useBarRoom(wantsRead, n);
  const reads = wantsRead && room.fits;
  return (
    <div ref={room.ref} className="ib-lhead ib-pickbar" role="toolbar" aria-label="Selected threads" data-pick-bar="" data-long={n >= 100 ? '' : undefined}>
      <PickBox state={all} label="Select all" onPick={onAll} />
      {/* The count is a live region: each pick is said, as the bar shows it. */}
      <span className="ib-pick-n" role="status" data-pick-count={n}>
        {n > 0 ? `${formatCount(n)} selected` : <span className="ib-pick-hint">{phone ? 'Tap threads to select them' : 'Click threads to select them'}</span>}
      </span>
      {n > 0 && !phone && (
        <>
          {archives && (
            <button type="button" className="ib-pick-btn" aria-label="Archive" data-bulk-action="archive" onClick={() => runBulk(act, 'archive')}>
              <Icon name="archive" size={15} className="ib-pick-i" />
              <span className="ib-pick-l">Archive</span>
            </button>
          )}
          {snoozes && (
            <BarMenu
              kind="snooze"
              act={act}
              phone={false}
              label="Snooze"
              className="ib-pick-btn"
              trigger={
                <>
                  <Icon name="clock" size={15} className="ib-pick-i" />
                  <span className="ib-pick-l">Snooze</span>
                </>
              }
            />
          )}
          {reads && (
            <button type="button" className="ib-pick-btn" aria-label="Mark read" data-bulk-action="read" onClick={() => void runBulk(act, 'read')}>
              <Icon name="checkCircle" size={15} className="ib-pick-i" />
              <span className="ib-pick-l">Mark read</span>
            </button>
          )}
          {!act.narrow && act.tidy && (
            <button type="button" className="ib-pick-btn" onClick={(event) => act.tidy!(event.currentTarget)} data-pick-tidy="">
              Tidy…
            </button>
          )}
          {!act.narrow && act.combine && (
            <Tip content={COMBINE_NEEDS_TWO} when={() => n < 2}>
              <button type="button" className="ib-pick-btn" aria-disabled={n < 2 || undefined} onClick={() => n >= 2 && act.combine!()} data-pick-combine="">
                Combine…
              </button>
            </Tip>
          )}
          <BarMenu kind="more" act={act} phone={false} label="More for the selected threads" className="ib-pick-btn ib-pick-ico" trigger={<Icon name="dots" size={16} />} skip={reads ? 'read' : undefined} />
        </>
      )}
      <button type="button" className="ib-pick-btn ib-pick-end" onClick={onDone} data-pick-done="">
        Done
      </button>
    </div>
  );
}

/** A phone's actions, in a sheet at the bottom edge while something is picked (6b). */
export function PickSheet({ act }: { act: PickActions }) {
  const sheet = useToastAbove();
  const archives = bulkTargets(act.rows, 'archive', act.rules).length > 0;
  const snoozes = act.snoozes && bulkTargets(act.rows, 'snooze', act.rules).length > 0;
  if (act.rows.length === 0) return null;
  return (
    <div ref={sheet} className="ib-picksheet" role="toolbar" aria-label="Selected threads" data-pick-sheet="">
      <button type="button" className="ib-pick-tool" disabled={!archives} onClick={() => runBulk(act, 'archive')} data-bulk-action="archive">
        <Icon name="archive" size={20} />
        Archive
      </button>
      {snoozes && (
        <BarMenu
          kind="snooze"
          act={act}
          phone
          label="Snooze"
          className="ib-pick-tool"
          trigger={
            <>
              <Icon name="clock" size={20} />
              Snooze
            </>
          }
        />
      )}
      {act.tidy && (
        <button type="button" className="ib-pick-tool" onClick={(event) => act.tidy!(event.currentTarget)} data-pick-tidy="">
          <Icon name="brush" size={20} />
          Tidy
        </button>
      )}
      {act.combine && (
        <button type="button" className="ib-pick-tool" disabled={act.rows.length < 2} onClick={() => act.combine!()} data-pick-combine="">
          <Icon name="swap" size={20} />
          Combine
        </button>
      )}
      <BarMenu
        kind="more"
        act={act}
        phone
        label="More"
        className="ib-pick-tool"
        trigger={
          <>
            <Icon name="dots" size={20} />
            More
          </>
        }
      />
    </div>
  );
}
