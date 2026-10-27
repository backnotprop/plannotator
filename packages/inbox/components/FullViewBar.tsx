import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { formatShortcutBindingText, formatShortcutBindingTokens } from '@plannotator/ui/shortcuts';
import { modKey } from '@plannotator/ui/utils/platform';
import { Icon } from '../icons';
import { Tip as HoverTip } from './Tip';

/**
 * The toolbar of full screen (approval "inbox-one-fullscreen", Drawer): the
 * file fills the window and this is all that is left over it. Top right on a
 * desktop, bottom right with 44 px targets on a phone. In order: Back to the
 * thread (where the file cannot sit beside the thread: a phone, a stacked
 * window), the pen (HTML that takes comments), the comment count (opens the
 * comments drawer), the position `N/M ⌄` (opens the file peek; on a phone a
 * pill that opens the peek's bottom sheet in one tap), ⋯ (Open in, Download,
 * the other version), Side by side, × Exit full screen (desktop only: what
 * Escape's last step does, not a pick), and » Hide tools in the corner.
 *
 * Hide tucks the toolbar into a handle flush with the corner (‹, the comment
 * count, an amber dot when the file changed since it was sent). A pointer in
 * the corner (a 96 × 64 px box that holds the handle) reveals it after
 * 120 ms; leaving tucks it again after 450 ms; while it is out that way the
 * last button is a pin that keeps it out. Tucked, the toolbar is `inert` and
 * the handle is a real button, so nothing invisible takes focus and focus is
 * never lost. Every opening of full screen starts with the toolbar showing.
 */
export type ToolbarState = 'pinned' | 'tucked' | 'revealed';

/** The pointer rests in the corner this long before the toolbar comes out. */
export const REVEAL_DELAY_MS = 120;
/** And leaves it this long before the toolbar tucks again. */
export const TUCK_DELAY_MS = 450;

export interface FullViewBarProps {
  phone: boolean;
  state: ToolbarState;
  onState: (next: ToolbarState) => void;
  /** Say something in the pane's live region. */
  announce: (text: string) => void;
  /** Annotate is armed (HTML). */
  armed: boolean;
  /** The pen, on an HTML file that takes comments. */
  onToggleArmed?: () => void;
  /** The comment count and its drawer (a sheet on a phone); absent when the file takes no comments and no other file has any. */
  comments: {
    count: number;
    open: boolean;
    controls: string;
    onToggle: () => void;
    buttonRef: RefObject<HTMLButtonElement | null>;
  } | null;
  /** The handle's count: the open file's comments (also when the file takes none and the count button is gone). */
  handleCount: number;
  /** The file changed since it was sent (or is gone): an amber dot on the handle. */
  changed: boolean;
  /**
   * The position and its peek (a thread with two or more files). On a phone it
   * is the `4/9 ⌄` pill that opens the peek's bottom sheet in one tap (the pane
   * draws the sheet: no `renderPeek`).
   */
  position: {
    index: number;
    total: number;
    name: string;
    open: boolean;
    peekId: string;
    onOpenChange: (open: boolean) => void;
    /** The peek, drawn under the bar while open (desktop); it closes through `close` with its reason. */
    renderPeek?: (close: (reason: 'key' | 'outside') => void) => ReactNode;
  } | null;
  /** ⋯: the trigger and its menu (OpenIn.tsx `FullScreenMore`), with whether its menu is open. */
  more: ReactNode;
  moreOpen: boolean;
  /**
   * The way out: Side by side (the file goes back beside the thread; a pick, remembered), or
   * Back to the thread where the file can only be full screen (a phone, a
   * stacked window), which leads the bar instead.
   */
  leave: { kind: 'exit' | 'back'; onLeave: () => void };
  /**
   * × Exit full screen, just before » (the corner stays »'s: a pointer that
   * reveals the toolbar there lands on the pin, never on ×). What Escape's
   * last step does, not a pick: back where full screen was opened from
   * (fullScreenOrigin.ts). Only where Side by side is the way out
   * (`leave.kind` `exit`, not a phone).
   */
  onExitFull?: () => void;
  /** × closes the file (a full screen opened from the thread alone): it is named Back to the thread, as a phone's way out is. */
  exitCloses?: boolean;
  /** The Hide / Show tools chord (`Mod+Shift+X`, HTML only), shown in the tooltips. */
  chord: string | null;
  /** The comments drawer is open beside the page (desktop): the dock sits left of it. */
  shifted: boolean;
}

export interface FullViewBarHandle {
  /** ⌘⇧X: tuck a showing toolbar, show a tucked one. */
  toggle: () => void;
}

function Keys({ binding }: { binding: string }) {
  return (
    <span className="flex items-center gap-1">
      {formatShortcutBindingTokens(binding).map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Tip({ text, note, binding, phone, passEscape, children }: { text: string; note?: string; binding?: string | null; phone: boolean; passEscape?: boolean; children: React.ReactElement }) {
  // A phone has no hover: a tooltip there only opens on focus, unseen, and takes the next Escape for itself. The buttons carry their names.
  if (phone) return children;
  return (
    <Tooltip
      side={phone ? 'top' : 'bottom'}
      wide
      escapePassesThrough={passEscape}
      content={
        <span className="flex flex-col gap-1">
          <span>{text}</span>
          {note && <span className="text-muted-foreground">{note}</span>}
          {binding && <Keys binding={binding} />}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const FullViewBar = forwardRef<FullViewBarHandle, FullViewBarProps>(function FullViewBar(props, ref) {
  const { phone, comments, position, state } = props;
  const barId = `ib-fvbar-${useId().replace(/:/g, '')}`;
  const dockRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const posRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the next state is drawn (the toolbar's inert flips first). */
  const pendingFocus = useRef<'handle' | 'bar' | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const popoverOpen = (position?.open ?? false) || props.moreOpen;
  const popoverRef = useRef(popoverOpen);
  popoverRef.current = popoverOpen;
  const where = phone ? 'bottom right' : 'top right';

  const clearTimers = () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (tuckTimer.current) clearTimeout(tuckTimer.current);
    revealTimer.current = null;
    tuckTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const set = (next: ToolbarState, focus: 'handle' | 'bar' | null = null, saying?: string) => {
    clearTimers();
    pendingFocus.current = focus;
    props.onState(next);
    if (saying) props.announce(saying);
    // The same state again (a pin pressed twice): the focus still lands.
    if (next === stateRef.current) applyFocus();
  };
  const setRef = useRef(set);
  setRef.current = set;

  const applyFocus = () => {
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    if (focus === 'handle') handleRef.current?.focus({ preventScroll: true });
    else if (focus === 'bar') barRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus({ preventScroll: true });
  };
  // Inert flips with the state, before paint: focus lands once it has. Focus is never lost: what held it and goes inert hands it on.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!pendingFocus.current && active && active !== document.body) {
      if (state === 'tucked' && barRef.current?.contains(active)) pendingFocus.current = 'handle';
      else if (state !== 'tucked' && active === handleRef.current) pendingFocus.current = 'bar';
    }
    if (barRef.current) barRef.current.inert = state === 'tucked';
    if (handleRef.current) handleRef.current.inert = state !== 'tucked';
    applyFocus();
    if (state !== 'revealed') clearTimers();
  }, [state]);

  const hide = (focusHandle: boolean) => set('tucked', focusHandle ? 'handle' : null, `Tools hidden. They are in the ${where} corner.`);
  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        if (stateRef.current === 'pinned') setRef.current('tucked', dockRef.current?.contains(document.activeElement) ? 'handle' : null, `Tools hidden. They are in the ${where} corner.`);
        else setRef.current('pinned', null, 'Tools shown.');
      },
    }),
    [where],
  );

  /** A revealed toolbar tucks again when the pointer has left, unless a popover is open or the keyboard is in it. */
  const maybeTuck = () => {
    if (stateRef.current !== 'revealed' || popoverRef.current) return;
    const active = document.activeElement;
    if (active && dockRef.current?.contains(active) && active.matches(':focus-visible')) return;
    setRef.current('tucked');
  };

  // A press outside the revealed toolbar (and its popovers) tucks it again; a pinned toolbar never moves.
  useEffect(() => {
    if (state !== 'revealed') return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-full-view-dock], [data-full-view-menu], [data-step-list]')) return;
      setRef.current('tucked');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [state]);

  /** The peek closed from the keyboard or by a choice: focus back on the position (not after a press elsewhere). A phone's sheet is the pane's, which puts focus back itself. */
  const refocus = useRef(false);
  const peekOpen = (position?.open ?? false) && position?.renderPeek !== undefined;
  useEffect(() => {
    if (peekOpen) refocus.current = true;
    else if (refocus.current) {
      refocus.current = false;
      posRef.current?.focus({ preventScroll: true });
    }
  }, [peekOpen]);
  const closePeek = (reason: 'key' | 'outside') => {
    // A press elsewhere on a desktop leaves focus where it went; Esc, Tab or a choice put it back on N/M.
    if (reason === 'outside' && !phone) refocus.current = false;
    position?.onOpenChange(false);
  };

  const count = props.handleCount;
  // A comment saved while the drawer is closed bumps the count (never on the first draw; with the drawer open the new card shows there instead).
  const lastCount = useRef(count);
  const [bump, setBump] = useState(0);
  const drawerOpen = comments?.open ?? false;
  useEffect(() => {
    if (count > lastCount.current && !drawerOpen) setBump((n) => n + 1);
    lastCount.current = count;
  }, [count, drawerOpen]);
  const handleLabel = `Show tools${count ? `, ${plural(count, 'comment')}` : ''}${props.changed ? ', file changed since sent' : ''}`;
  const pinned = state === 'pinned';
  const hideText = pinned ? 'Hide tools' : 'Keep tools out';
  const iconSize = phone ? 18 : 15;

  // The way out of full screen names where it goes, "Side by side" (a pick: remembered); on a phone or a stacked window it is Back to the thread.
  const exit = props.leave.kind === 'exit';
  const leaveButton = (
    <Tip text={exit ? 'Side by side' : 'Back to the thread'} note={exit ? 'The file beside the thread; files open this way until you choose again' : undefined} phone={phone}>
      <button
        type="button"
        className={`ib-fvb ib-fvexit${exit ? ' ib-fvside' : ''}`}
        onClick={props.leave.onLeave}
        aria-label={exit ? 'Side by side' : 'Back to the thread'}
        data-full-view-exit={props.leave.kind}
      >
        <Icon name={exit ? 'sideBySide' : 'chevL'} size={exit ? iconSize : phone ? 20 : 16} />
        {exit && <span>Side by side</span>}
      </button>
    </Tip>
  );

  return (
    <div
      ref={dockRef}
      className={`ib-fvdock${phone ? ' ib-fvdock-phone' : ''}${props.shifted ? ' ib-shift' : ''}`}
      data-full-view-dock=""
      data-bar={state}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || phone) return;
        if (tuckTimer.current) clearTimeout(tuckTimer.current);
        tuckTimer.current = null;
        if (stateRef.current === 'tucked' && !revealTimer.current) revealTimer.current = setTimeout(() => {
          revealTimer.current = null;
          if (stateRef.current === 'tucked') setRef.current('revealed');
        }, REVEAL_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch' || phone) return;
        if (revealTimer.current) clearTimeout(revealTimer.current);
        revealTimer.current = null;
        if (stateRef.current === 'revealed') tuckTimer.current = setTimeout(() => {
          tuckTimer.current = null;
          maybeTuck();
        }, TUCK_DELAY_MS);
      }}
      onBlur={(event) => {
        // Focus that leaves the revealed toolbar tucks it, without moving focus.
        if (stateRef.current !== 'revealed') return;
        const to = event.relatedTarget as Element | null;
        if (!to || dockRef.current?.contains(to) || to.closest('[data-full-view-menu], [data-step-list]')) return;
        setRef.current('tucked');
      }}
      // Capture: a tooltip open on the focused button would take Escape first, and the count's Escape closes its open drawer.
      onKeyDownCapture={(event) => {
        const onOpenCount = comments?.open && comments.buttonRef.current === event.target;
        if (event.key === 'Escape' && stateRef.current === 'revealed' && !popoverRef.current && !onOpenCount) {
          event.preventDefault();
          setRef.current('tucked', 'handle');
        }
      }}
    >
      {!phone && <div className="ib-fvzone" aria-hidden="true" />}
      <HoverTip content="Show tools">
        <button
          type="button"
          ref={handleRef}
          className="ib-fvhandle"
          onClick={(event) => set('revealed', event.detail === 0 ? 'bar' : null)}
          aria-controls={barId}
          aria-expanded={state !== 'tucked'}
          aria-label={handleLabel}
          data-full-view-handle=""
        >
          <Icon name="chevL" size={phone ? 18 : 14} />
          {count > 0 && (
            <span key={bump} className={`ib-fvhandle-n${bump ? ' ib-bump' : ''}`}>
              {count}
            </span>
          )}
          {props.changed && <span className="ib-fvhandle-dot" aria-hidden="true" />}
        </button>
      </HoverTip>
      <div
        ref={barRef}
        id={barId}
        className={`ib-fvbar${phone ? ' ib-fvbar-phone' : ''}`}
        role="toolbar"
        aria-label="Full screen"
        data-full-view-bar=""
      >
        {props.leave.kind === 'back' && leaveButton}
        {props.onToggleArmed && (
          <Tip text={props.armed ? `Annotate: click an element or select text to comment; links open (${modKey}-click one to comment on it). Esc to interact` : 'Interact: clicks reach the page. Click to annotate'} phone={phone}>
            <button
              type="button"
              className={`ib-fvb${props.armed ? ' ib-on' : ''}`}
              onClick={props.onToggleArmed}
              aria-pressed={props.armed}
              aria-label={props.armed ? 'Annotate mode' : 'Interact mode'}
              data-full-view-pen=""
            >
              <Icon name="pen" size={phone ? 18 : 16} />
            </button>
          </Tip>
        )}
        {comments && (
          <Tip text={comments.open ? 'Close the comments' : 'Comments'} phone={phone}>
            <button
              type="button"
              ref={comments.buttonRef}
              className={`ib-fvb ib-fvcount${comments.count === 0 ? ' ib-zero' : ''}${comments.open ? ' ib-open' : ''}`}
              onClick={comments.onToggle}
              onKeyDown={(event) => {
                // Escape on the count closes its open drawer (focus stays here); full screen stays.
                if (event.key === 'Escape' && comments.open && !event.defaultPrevented) {
                  event.preventDefault();
                  event.stopPropagation();
                  comments.onToggle();
                }
              }}
              aria-expanded={comments.open}
              aria-controls={comments.controls}
              aria-label={`Comments, ${comments.count}`}
              data-full-view-comments=""
            >
              <Icon name="comment" size={iconSize} />
              <span key={bump} className={bump ? 'ib-bump' : undefined}>
                {comments.count}
              </span>
            </button>
          </Tip>
        )}
        {position && (
          <span className="ib-fvpos">
            <button
              type="button"
              ref={posRef}
              className={`ib-fvb ib-fvposb${phone ? ' ib-fvpill' : ''}`}
              aria-haspopup="grid"
              aria-expanded={position.open}
              aria-controls={position.open ? position.peekId : undefined}
              // A phone's pill: its name starts with the text it shows (WCAG 2.5.3, Label in Name), then says it in words.
              aria-label={
                phone
                  ? `${position.index + 1}/${position.total}: file ${position.index + 1} of ${position.total}, ${position.name}. Show every file`
                  : `${position.index + 1} of ${position.total}, ${position.name}. Show every file in this thread`
              }
              onClick={() => position.onOpenChange(!position.open)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && !position.open) {
                  event.preventDefault();
                  position.onOpenChange(true);
                }
              }}
              data-full-view-position=""
              data-peek-opener=""
            >
              <span>{position.index + 1}</span>
              <small>/{position.total}</small>
              <span className={`ib-stepchev${position.open ? ' ib-on' : ''}`} aria-hidden="true">
                <Icon name="chevD" size={12} />
              </span>
            </button>
            {position.open && position.renderPeek && (
              <div className="ib-fvpeek" data-step-list="">
                {position.renderPeek(closePeek)}
              </div>
            )}
          </span>
        )}
        <span className="ib-fvdv" aria-hidden="true" />
        {props.more}
        {props.leave.kind === 'exit' && leaveButton}
        {props.onExitFull && props.leave.kind === 'exit' && !phone && (
          // Its tooltip says Esc, so one Esc on it leaves (the tooltip does not keep that press).
          <Tip text={props.exitCloses ? 'Back to the thread' : 'Exit full screen'} binding="Escape" phone={phone} passEscape>
            <button
              type="button"
              className="ib-fvb"
              onClick={props.onExitFull}
              aria-label={props.exitCloses ? 'Back to the thread' : 'Exit full screen'}
              aria-keyshortcuts="Escape"
              data-full-view-close=""
            >
              <Icon name="x" size={iconSize} />
            </button>
          </Tip>
        )}
        <Tip text={hideText} binding={props.chord} phone={phone}>
          <button
            type="button"
            className="ib-fvb ib-fvhide"
            onClick={() => {
              if (pinned) hide(true);
              // The pin becomes » in place: focus stays on it.
              else set('pinned', null, 'Tools pinned. They stay out.');
            }}
            aria-label={hideText}
            aria-description={props.chord ? `Shortcut: ${formatShortcutBindingText(props.chord)}` : undefined}
            data-full-view-hide={pinned ? 'hide' : 'pin'}
          >
            <Icon name={pinned ? 'chevsR' : 'pin'} size={iconSize} />
          </button>
        </Tip>
      </div>
    </div>
  );
});
