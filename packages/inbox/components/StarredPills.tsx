import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { agentName, formatCount } from '../format';
import { AuthorMark, Icon } from '../icons';
import { fitPills, moreName, pillName, pillWaits, starredPills, type StarredPill } from '../starredPills';
import { rowAgent, titleOf } from './InboxList';
import type { PinnedAction } from './PinnedRow';
import { pinEnds } from '../pins';
import { Tip } from './Tip';
import { useContextMenuTrigger } from './useContextMenuTrigger';

/** How long a finger rests on a pill before its menu opens, and how far it may drift (a sideways scroll is not a press). */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
/** The room "+N"'s dot takes (the dot and its gap), counted while it is not drawn. */
const MORE_DOT = 12;

export interface StarredPillsProps {
  /** The starred threads, in star order (the list model's `pins`). */
  rows: readonly InboxListRow[];
  /** Each project as the window names it. */
  projectNames?: ReadonlyMap<string, string>;
  /** The thread on screen: its pill stays pressed. */
  openThreadId: string | null;
  /** A phone: one line that scrolls sideways, no "+N"; the menu is a sheet from the bottom edge. */
  phone: boolean;
  onOpen: (row: InboxListRow) => void;
  /** Unstar, Move left (`up`), Move right (`down`), Copy link: the sidebar's pinned row actions. */
  onAction: (row: InboxListRow, action: PinnedAction) => void;
}

/**
 * The starred threads as pills above the list's first section (approval "inbox-starred-pills", option (iv) gold):
 * a gold star, the thread's name and its state (the sidebar's Starred grammar: Stopped, Holds N, the open questions,
 * a dot for news, the archive glyph). A waiting pill's name is bold; the open thread's pill stays pressed.
 *
 * A click on the star unstars (the star is a sibling button over the pill's left end, out of the tab order, so it
 * never opens the thread); a click anywhere else opens the thread. A right-click, the context-menu key or Shift+F10
 * on a pill opens Unstar, Move left, Move right and Copy link (`useContextMenuTrigger`, the thread rows' rules). On a
 * touch screen the star is a picture: a tap anywhere opens, and a long press opens the same menu (a bottom sheet on a
 * phone).
 *
 * A wider window: at most two lines, then "+N" (with a dot when a hidden thread waits), a menu of the rest, each row
 * with its own star to unstar it. A phone:
 * one line that scrolls sideways, its right edge faded, with a dot in a gutter at the right while a waiting pill is
 * past the edge. Nothing is drawn with nothing starred. No keyboard shortcut.
 */
export function StarredPills(props: StarredPillsProps) {
  const { rows, phone } = props;
  const pills = useMemo(() => starredPills(rows, titleOf, props.projectNames), [rows, props.projectNames]);
  const byId = useMemo(() => new Map(pills.map((pill) => [pill.row.thread_id, pill])), [pills]);
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(nav.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);

  // ── "+N": how many pills fit on two lines (never on a phone, whose line scrolls) ──
  const [shown, setShown] = useState<number>(pills.length);
  const count = phone ? pills.length : Math.min(shown, pills.length);
  const hidden = pills.slice(count);
  // What decides the fit besides the width: every pill's words and state.
  const fitKey = pills.map((pill) => `${pill.row.thread_id}:${pill.label}:${pill.twin ? pill.project : ''}:${pill.state.kind}:${pill.state.n}:${pill.row.unread ? 1 : 0}`).join('|');
  useLayoutEffect(() => {
    const ul = list.current;
    if (phone || !ul) return;
    const measure = () => {
      const items = [...ul.querySelectorAll<HTMLElement>(':scope > li[data-pill-item]')];
      const more = ul.querySelector<HTMLElement>(':scope > li[data-pill-more]');
      const gap = Number.parseFloat(getComputedStyle(ul).columnGap) || 0;
      // "+N" is measured with its dot, shown or not, so the fit never depends on which pills it hides.
      const dot = more && !more.querySelector('.ib-pdot') ? MORE_DOT : 0;
      const next = fitPills(items.map((item) => item.offsetWidth), (more?.offsetWidth ?? 0) + dot, ul.clientWidth, gap);
      setShown((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(ul);
    return () => observer.disconnect();
  }, [phone, fitKey]);

  // ── A phone: the dot in the gutter while a waiting pill is past the right edge ──
  const [edge, setEdge] = useState(false);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const ul = list.current;
    if (!phone || !ul) {
      setEdge(false);
      return;
    }
    const read = () => {
      const right = ul.scrollLeft + ul.clientWidth;
      setFits(ul.scrollWidth <= ul.clientWidth + 1);
      // Past the edge: less than a third of it (its star and the start of its name) is in view.
      setEdge([...ul.querySelectorAll<HTMLElement>(':scope > li[data-pill-waits]')].some((item) => item.offsetLeft + item.offsetWidth / 3 > right));
    };
    read();
    ul.addEventListener('scroll', read, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(ul);
    return () => {
      ul.removeEventListener('scroll', read);
      observer?.disconnect();
    };
  }, [phone, fitKey]);

  // ── The right-click menu (and the menu key, Shift+F10): one menu for every pill ──
  const buttonFor = (id: string): HTMLElement | null => list.current?.querySelector<HTMLElement>(`[data-starred-pill="${CSS.escape(id)}"]`) ?? null;
  const menu = useContextMenuTrigger({
    itemOf: (target) => (target instanceof Element ? (target.closest<HTMLElement>('li[data-pill-item]')?.querySelector<HTMLElement>('[data-starred-pill]') ?? null) : null),
    idOf: (button) => button.getAttribute('data-starred-pill'),
    has: (id) => byId.has(id),
    buttonFor,
    // An unstarred pill: the pill now in its place, else the list header's ⋮ (where the choice lives).
    slotOf: () => ({
      order: pills.slice(0, count).map((pill) => pill.row.thread_id),
      fallback: () => nav.current?.closest('.ib-listcol')?.querySelector<HTMLElement>('[data-tidy-menu]') ?? null,
    }),
    // A pill is there or it is not: Unstar is the only write that takes one away.
    stateOf: (id) => (byId.has(id) ? 'starred' : ''),
    onTarget: () => {},
  });
  const target = menu.targetId ? (byId.get(menu.targetId) ?? null) : null;

  // ── A long press on a touch screen: the same items, a sheet on a phone ──
  const [sheetId, setSheetId] = useState<string | null>(null);
  const sheet = sheetId ? (byId.get(sheetId) ?? null) : null;
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  /** The click that ends a long press opens nothing. */
  const swallowClick = useRef(false);
  /**
   * The finger that opened the sheet is still down, or has only just lifted: its lift (a click, which lands on the
   * sheet's scrim now under it) closes nothing.
   */
  const sheetHeld = useRef(false);
  useEffect(() => {
    if (sheetId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lifted = () => {
      timer ??= setTimeout(() => {
        sheetHeld.current = false;
      }, 350);
    };
    window.addEventListener('pointerup', lifted, true);
    window.addEventListener('pointercancel', lifted, true);
    return () => {
      window.removeEventListener('pointerup', lifted, true);
      window.removeEventListener('pointercancel', lifted, true);
      if (timer) clearTimeout(timer);
      sheetHeld.current = false;
    };
  }, [sheetId]);
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => endPress, []);
  const pressHandlers = (id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (event.pointerType !== 'touch') return;
      endPress();
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          swallowClick.current = true;
          sheetHeld.current = true;
          setSheetId(id);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const now = press.current;
      if (now && Math.hypot(event.clientX - now.x, event.clientY - now.y) > LONG_PRESS_SLOP) endPress();
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onPointerLeave: endPress,
  });

  /** The star took a touch: on a touch screen it is a picture, and the tap opens the thread. */
  const starTouched = useRef(false);

  if (pills.length === 0) return null;

  const act = (pill: StarredPill, action: PinnedAction) => {
    if (action === 'unpin') menu.follow(pill.row.thread_id, true);
    props.onAction(pill.row, action);
  };
  const items = (pill: StarredPill, close: () => void) => {
    const at = pills.indexOf(pill);
    const run = (action: PinnedAction) => () => {
      close();
      act(pill, action);
    };
    return (
      <>
        {/* The popup is named by the label already (aria-label): the title is for the eye only (a phone's sheet). */}
        <div className="ib-pm-title" dir="auto" aria-hidden="true">
          {pill.label}
        </div>
        <Menu.Item className="ib-pmi" label="Unstar" onClick={run('unpin')} data-pill-action="unpin">
          <Icon name="star" size={15} className="ib-star-on" />
          Unstar
        </Menu.Item>
        <Menu.Item className="ib-pmi" label="Move left" disabled={pinEnds(pills.map((p) => p.row), at).first} onClick={run('up')} data-pill-action="left">
          <Icon name="back" size={15} />
          Move left
        </Menu.Item>
        <Menu.Item className="ib-pmi" label="Move right" disabled={pinEnds(pills.map((p) => p.row), at).last} onClick={run('down')} data-pill-action="right">
          <Icon name="arrowRight" size={15} />
          Move right
        </Menu.Item>
        <Menu.Separator className="ib-pm-sep" />
        <Menu.Item className="ib-pmi" label="Copy link" onClick={run('copy-link')} data-pill-action="copy-link">
          <Icon name="link" size={15} />
          Copy link
        </Menu.Item>
      </>
    );
  };

  return (
    <nav
      ref={nav}
      className="ib-stars"
      aria-label="Starred"
      data-starred-pills=""
      data-phone={phone ? '' : undefined}
      data-edge={phone && edge ? '' : undefined}
      data-fits={phone && fits ? '' : undefined}
    >
      <ContextMenu.Root {...menu.root}>
        <ContextMenu.Trigger render={<ul ref={list} className="ib-stars-l" />} {...menu.trigger}>
          {pills.map((pill, index) => {
            const { row } = pill;
            const on = props.openThreadId === row.thread_id;
            const over = index >= count;
            return (
              <li
                key={row.thread_id}
                className="ib-star-i"
                data-pill-item=""
                data-pill-waits={pillWaits(pill.state) ? '' : undefined}
                // Behind "+N": kept for its width (the fit is measured), out of the layout, the tab order and the tree.
                data-over={over ? '' : undefined}
                aria-hidden={over ? true : undefined}
              >
                <Tip side="bottom" align="start" content={<PillTip pill={pill} />}>
                  <button
                    type="button"
                    className="ib-star-p"
                    aria-label={pillName(pill)}
                    aria-current={on ? 'true' : undefined}
                    tabIndex={over ? -1 : undefined}
                    data-starred-pill={row.thread_id}
                    data-state={pill.state.kind}
                    data-wake={pill.state.calm ? undefined : ''}
                    data-unread={row.unread ? '' : undefined}
                    data-menu={menu.targetId === row.thread_id || sheetId === row.thread_id ? '' : undefined}
                    onClick={() => {
                      if (swallowClick.current) {
                        swallowClick.current = false;
                        return;
                      }
                      props.onOpen(row);
                    }}
                    {...pressHandlers(row.thread_id)}
                  >
                    <span className="ib-star-n" dir="auto">
                      {pill.label}
                    </span>
                    {pill.twin && (
                      <span className="ib-star-proj" dir="auto">
                        {pill.project}
                      </span>
                    )}
                    <PillState pill={pill} />
                  </button>
                </Tip>
                <Tip content={<span data-pill-unstar-tip="">Unstar</span>} side="top">
                  <button
                    type="button"
                    className="ib-star-x"
                    // Out of the tab order: the keyboard's Unstar is the pill's menu (the menu key, Shift+F10).
                    tabIndex={-1}
                    aria-label={`Unstar ${pill.label}`}
                    data-pill-unstar={row.thread_id}
                    onPointerDown={(event) => {
                      starTouched.current = event.pointerType === 'touch';
                    }}
                    onClick={() => {
                      const touched = starTouched.current;
                      starTouched.current = false;
                      if (touched) props.onOpen(row);
                      else props.onAction(row, 'unpin');
                    }}
                  >
                    <Icon name="star" size={13} />
                  </button>
                </Tip>
              </li>
            );
          })}
          {!phone && (
            // Always drawn so its width is known before it is needed; out of sight and reach while every pill fits.
            <li className="ib-star-i" data-pill-more="" data-over={hidden.length === 0 ? '' : undefined} aria-hidden={hidden.length === 0 ? true : undefined}>
              <MorePills hidden={hidden} total={pills.length} portal={portal} openThreadId={props.openThreadId} onOpen={props.onOpen} onUnstar={(row) => props.onAction(row, 'unpin')} />
            </li>
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal container={portal ?? undefined}>
          <ContextMenu.Positioner className="ib-pm-pos">
            <ContextMenu.Popup className="ib-pm" aria-label={target?.label ?? 'Starred thread'} data-pill-menu={target?.row.thread_id} {...menu.popup}>
              {target && items(target, () => {})}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {phone && edge && <span className="ib-pdot ib-stars-edge" aria-hidden="true" data-pills-edge="" />}
      {/* The long press's menu: anchored to its pill, a sheet from the bottom edge on a phone. */}
      <Menu.Root
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open && !sheetHeld.current) setSheetId(null);
        }}
        modal={phone}
      >
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} anchor={() => (sheetId ? buttonFor(sheetId) : null)} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={sheet?.label ?? 'Starred thread'} data-pill-sheet={sheet?.row.thread_id} finalFocus={() => (sheetId ? (buttonFor(sheetId) ?? true) : true)}>
              {sheet &&
                items(sheet, () => {
                  sheetHeld.current = false;
                  setSheetId(null);
                })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </nav>
  );
}

/** A pill's state, as the sidebar's starred row shows it: a Stopped or Holds N pill, the open questions, a dot for news, the archive glyph. */
function PillState({ pill }: { pill: StarredPill }) {
  const { state } = pill;
  if (state.kind === 'stop')
    return (
      <span className="ib-spill" data-k="stop" aria-hidden="true">
        Stopped
      </span>
    );
  if (state.kind === 'hold')
    return (
      <span className="ib-spill" data-k="hold" aria-hidden="true">
        Holds {formatCount(state.n)}
      </span>
    );
  if (state.kind === 'wait')
    return (
      <span className="ib-star-q" aria-hidden="true">
        <Icon name="questionBubble" size={12} />
        {formatCount(state.n)}
      </span>
    );
  if (state.kind === 'new') return <span className="ib-pdot" data-k="new" aria-hidden="true" />;
  if (state.kind === 'archived')
    return (
      <span className="ib-parch" aria-hidden="true">
        <Icon name="archive" size={13} />
      </span>
    );
  return null;
}

/** A pill's tooltip: the whole name (the pill may cut it), the subject when it differs, then the agent and its project. */
function PillTip({ pill }: { pill: StarredPill }) {
  const subject = pill.row.subject ?? '(no subject)';
  const agent = rowAgent(pill.row);
  return (
    <span className="ib-tip-proj" data-pill-tip="">
      <bdi className="ib-tip-name">{pill.label}</bdi>
      {pill.label !== subject && (
        <span className="ib-tip-sub">
          <bdi>{subject}</bdi>
        </span>
      )}
      <span className="ib-tip-sub ib-star-tipag" data-pill-tip-agent="">
        <AuthorMark author={agent} />
        <span>
          {agentName(agent)} in <bdi>{pill.project}</bdi>
        </span>
      </span>
    </span>
  );
}

/**
 * "+N": the starred threads past the second line, in a menu. A row is a pill laid flat: the gold star at its left,
 * the thread's name and its state (the owner, on the PR: "the drop-down menu for the pluses should have the stars
 * too, so I can unstar the ones in the drop-down"). The star unstars and never opens the thread (a sibling of the
 * row's item, as on a pill); the rest of the row opens it. After an unstar the menu stays open with the row gone and
 * focus on the row now in its place; it closes when nothing is hidden any more.
 *
 * Keys: the rows are the menu's items (↑ ↓, Enter). ← on a row goes to its star ("Unstar <name>", Enter or Space),
 * → comes back, and ↑ ↓ on a star go to the row above or below. No menu in the Inbox had a second action in a row
 * before this one. No shortcut.
 */
function MorePills({
  hidden,
  total,
  portal,
  openThreadId,
  onOpen,
  onUnstar,
}: {
  hidden: readonly StarredPill[];
  total: number;
  portal: HTMLElement | null;
  openThreadId: string | null;
  onOpen: (row: InboxListRow) => void;
  onUnstar: (row: InboxListRow) => void;
}) {
  const none = hidden.length === 0;
  const waits = hidden.some((pill) => pillWaits(pill.state));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  /** An unstar from the menu: once its row is gone, focus goes to the row now at this place. */
  const refocus = useRef<{ at: number; until: number } | null>(null);
  const ids = hidden.map((pill) => pill.row.thread_id).join('|');
  const items = () => [...(popup.current?.querySelectorAll<HTMLElement>('[data-pills-more-item]') ?? [])];
  useLayoutEffect(() => {
    const pending = refocus.current;
    if (!pending) return;
    refocus.current = null;
    if (Date.now() > pending.until) return;
    const rows = items();
    rows[Math.min(pending.at, rows.length - 1)]?.focus({ preventScroll: true });
  }, [ids]);
  // Nothing hidden any more (the last row was unstarred, or the list grew wider): no menu to show.
  useEffect(() => {
    if (none && open) setOpen(false);
  }, [none, open]);
  return (
    <Menu.Root open={open && !none} onOpenChange={setOpen} modal={false}>
      <Menu.Trigger ref={trigger} className="ib-star-p ib-star-more" aria-label={moreName(hidden)} tabIndex={none ? -1 : undefined} data-pills-more="">
        {/* Drawn (out of sight) before it is needed, so its width is known: then with the widest count it can show. */}+{formatCount(none ? total : hidden.length)}
        {waits && <span className="ib-pdot" aria-hidden="true" data-pills-more-dot="" />}
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={6}>
          <Menu.Popup
            ref={popup}
            className="ib-pm ib-star-menu"
            aria-label="More starred"
            data-pills-more-menu=""
            // "+N" itself goes with its last row: focus then goes to the last pill on screen.
            finalFocus={() => {
              const more = trigger.current;
              if (more && !more.closest('[data-over]')) return more;
              const shown = more?.closest('ul')?.querySelectorAll<HTMLElement>('li[data-pill-item]:not([data-over]) [data-starred-pill]');
              return shown?.[shown.length - 1] ?? true;
            }}
          >
            {hidden.map((pill, index) => {
              const id = pill.row.thread_id;
              return (
                <div key={id} className="ib-star-mrow" role="none" data-pills-more-row={id}>
                  <Menu.Item
                    className="ib-pmi"
                    label={pill.label}
                    aria-label={pillName(pill)}
                    aria-current={openThreadId === id ? 'true' : undefined}
                    data-pills-more-item={id}
                    onClick={() => onOpen(pill.row)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft') return;
                      event.preventDefault();
                      event.preventBaseUIHandler();
                      event.currentTarget.parentElement?.querySelector<HTMLElement>('[data-pills-more-unstar]')?.focus();
                    }}
                  >
                    <span className="ib-star-mi-l" dir="auto">
                      {pill.label}
                    </span>
                    {pill.twin && (
                      <span className="ib-star-mi-p" dir="auto">
                        {pill.project}
                      </span>
                    )}
                    <span className="ib-star-mi-s">
                      <PillState pill={pill} />
                    </span>
                  </Menu.Item>
                  <Tip content={<span data-pill-unstar-tip="">Unstar</span>} side="left">
                    <button
                      type="button"
                      // One of the menu's items for a screen reader; reached with ← from its row, never with Tab.
                      role="menuitem"
                      tabIndex={-1}
                      className="ib-star-x"
                      aria-label={`Unstar ${pill.label}`}
                      data-pills-more-unstar={id}
                      onClick={() => {
                        refocus.current = { at: index, until: Date.now() + 5000 };
                        onUnstar(pill.row);
                      }}
                      onKeyDown={(event) => {
                        const rows = items();
                        const to = event.key === 'ArrowRight' ? index : event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : null;
                        if (to === null) return;
                        // The menu's own arrows read its items: this star is not one of them.
                        event.preventDefault();
                        event.stopPropagation();
                        rows[(to + rows.length) % rows.length]?.focus();
                      }}
                    >
                      <Icon name="star" size={13} />
                    </button>
                  </Tip>
                </div>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
