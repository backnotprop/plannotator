import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { formatShortcutBindingText } from '@plannotator/ui/shortcuts';
import { inboxFileViewerShortcuts } from '../shortcuts/fileViewer.shortcuts';
import { shortcutAria, TipKeys, type ShortcutRef } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';

const EXIT_KEYS: ShortcutRef = { scope: inboxFileViewerShortcuts, action: 'escape' };
/** F: out of full screen the way × goes (Thread.tsx `fullScreenByKey`). */
const FULL_KEYS: ShortcutRef = { scope: inboxThreadShortcuts, action: 'fullScreen' };
const TOOLS_KEYS: ShortcutRef = { scope: inboxFileViewerShortcuts, action: 'toggleTools' };
const exitKeys = shortcutAria(EXIT_KEYS);
import { modKey } from '@plannotator/ui/utils/platform';
import { Icon } from '../icons';
import { CommentCount, commentsLabel } from './EarlierSection';
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
 * Escape's last step does, not a pick), and » Hide tools.
 *
 * Hide gathers every floating control of full screen (this toolbar, the
 * composer or its pill, the image's size bar, a text file's toolstrip and
 * Contents button) into one small control in the bottom right corner
 * (approval "inbox-fullscreen-gather"). The composer's own ⌄ does the same (FullScreenComposer.tsx),
 * so either bar's minimize does one thing. The corner control carries what
 * waits (the comment count, "Draft" while a reply draft waits, an amber dot
 * when the file changed since it was sent); one press brings everything back.
 * Gathered, the toolbar is `inert` and the corner control is a real button,
 * so nothing invisible takes focus and focus is never lost. Every opening of
 * full screen starts with the tools showing.
 */
export type ToolbarState = 'pinned' | 'tucked';

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
  /** The comment count and its drawer (a sheet on a phone); absent when the file takes no comments and has none to list, here or on another file. */
  comments: {
    count: number;
    /** Comments a Send already carried on this file (earlierComments.ts). Absent or 0: the count is today's. */
    earlier?: number;
    open: boolean;
    controls: string;
    onToggle: () => void;
    buttonRef: RefObject<HTMLButtonElement | null>;
  } | null;
  /** The corner control's count: the open file's comments (also when the file takes none and the count button is gone). */
  handleCount: number;
  /** The file changed since it was sent (or is gone): an amber dot on the corner control. */
  changed: boolean;
  /** A reply draft waits in full screen's composer (words or files): the corner control says "Draft". */
  draft?: boolean;
  /** Where focus goes when the tools come back from the corner; absent or null: » (where Hide was pressed). */
  restoreTarget?: () => HTMLElement | null;
  /**
   * The position and its peek (a thread with two or more files). On a phone it
   * is the `4/9 ⌄` pill that opens the peek's bottom sheet in one tap (the pane
   * draws the sheet: no `renderPeek`).
   */
  position: {
    index: number;
    total: number;
    name: string;
    /** What `index` of `total` counts: the thread's files, or a question's picture choices (optionSets.ts). Absent: files. */
    noun?: 'file' | 'option';
    open: boolean;
    peekId: string;
    onOpenChange: (open: boolean) => void;
    /** The peek, drawn under the bar while open (desktop); it closes through `close` with its reason. */
    renderPeek?: (close: (reason: 'key' | 'outside') => void) => ReactNode;
  } | null;
  /** Ask AI's icon, before ⋯. Absent: nothing there. */
  ask?: ReactNode;
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
   * × Exit full screen, just before » (the bar's end stays »'s). What Escape's
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
  /** ⌘⇧X: gather showing tools into the corner, bring gathered ones back. */
  toggle: () => void;
  /** Gather the tools into the corner (the composer's ⌄), focus on the corner control. */
  hide: () => void;
}

function Tip({ text, note, keys, phone, passEscape, children }: { text: string; note?: string; keys?: ShortcutRef | readonly ShortcutRef[] | null; phone: boolean; passEscape?: boolean; children: React.ReactElement }) {
  const refs = keys ? (Array.isArray(keys) ? keys : [keys as ShortcutRef]) : [];
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
          {refs.length > 0 && (
            <span className="flex items-center gap-2">
              {refs.map((ref) => (
                <TipKeys key={`${ref.scope.id}.${ref.action}`} {...ref} />
              ))}
            </span>
          )}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** What the live region says when the tools gather. */
const HIDDEN_SAYING = 'Tools hidden. They are in the bottom right corner.';
/**
 * What floats over a file in full screen and gathers into the corner control (inbox.css): this toolbar, the composer
 * or its pill, an image's size bar and its "Your marked-up copy" chip, a text file's toolstrip, its Contents button
 * and ui's Contents rail (the ticks at the page's right edge, with the panel and its Hide). The changed chip is not
 * here: it is a fact about the file.
 */
export const GATHERED =
  '.ib-fvbar, .ib-fcomp, .ib-fcomp-pillwrap, .ib-imgbar, .ib-imgshowing, .ib-toolstrip, .ib-contents-open, .pn-contents-rail';
/** Focus sits in something that is about to gather (and go inert or hidden). */
const focusGathers = () => document.activeElement instanceof Element && document.activeElement.closest(GATHERED) !== null;

export const FullViewBar = forwardRef<FullViewBarHandle, FullViewBarProps>(function FullViewBar(props, ref) {
  const { phone, comments, position, state } = props;
  const barId = `ib-fvbar-${useId().replace(/:/g, '')}`;
  const barRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const posRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the next state is drawn (the toolbar's inert flips first). */
  const pendingFocus = useRef<'handle' | 'bar' | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const restoreRef = useRef(props.restoreTarget);
  restoreRef.current = props.restoreTarget;

  const set = (next: ToolbarState, focus: 'handle' | 'bar' | null = null, saying?: string) => {
    pendingFocus.current = focus;
    props.onState(next);
    if (saying) props.announce(saying);
    // The same state again: the focus still lands.
    if (next === stateRef.current) applyFocus();
  };
  const setRef = useRef(set);
  setRef.current = set;

  const applyFocus = () => {
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    if (focus === 'handle') handleRef.current?.focus({ preventScroll: true });
    // Back from the corner: where the person gathered from (the composer's field, else »).
    else if (focus === 'bar') (restoreRef.current?.() ?? hideRef.current)?.focus({ preventScroll: true });
  };
  // Inert flips with the state, before paint: focus lands once it has. Focus is never lost: what held it and goes inert hands it on.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!pendingFocus.current && active && active !== document.body) {
      if (state === 'tucked' && active.closest(GATHERED)) pendingFocus.current = 'handle';
      else if (state !== 'tucked' && active === handleRef.current) pendingFocus.current = 'bar';
    }
    if (barRef.current) barRef.current.inert = state === 'tucked';
    if (handleRef.current) handleRef.current.inert = state !== 'tucked';
    applyFocus();
  }, [state]);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        // Focus in anything that gathers (the toolbar, a button of the card, the size bar) goes to the corner control, never to the body.
        if (stateRef.current === 'pinned') setRef.current('tucked', focusGathers() ? 'handle' : null, HIDDEN_SAYING);
        else setRef.current('pinned', null, 'Tools shown.');
      },
      hide: () => setRef.current('tucked', 'handle', HIDDEN_SAYING),
    }),
    [],
  );

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
  const handleLabel = `Show tools${props.draft ? ', reply draft' : ''}${count ? `, ${plural(count, 'comment')}` : ''}${props.changed ? ', file changed since sent' : ''}`;
  const iconSize = phone ? 18 : 15;

  // The way out of full screen names where it goes, "Side by side" (a pick: remembered); on a phone or a stacked window it is Back to the thread.
  const exit = props.leave.kind === 'exit';
  const leaveButton = (
    // F is named once, on the control that does what it does (approved hint placement): here where full screen came
    // from beside the thread (F goes back there, saving nothing); on × where × closes the file.
    <Tip text={exit ? 'Side by side' : 'Back to the thread'} note={exit ? 'The file beside the thread; files open this way until you choose again' : undefined} keys={exit && !props.exitCloses ? FULL_KEYS : null} phone={phone}>
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
      className={`ib-fvdock${phone ? ' ib-fvdock-phone' : ''}${props.shifted ? ' ib-shift' : ''}`}
      data-full-view-dock=""
      data-bar={state}
    >
      <HoverTip content="Show tools">
        <button
          type="button"
          ref={handleRef}
          className="ib-fvhandle"
          onClick={() => set('pinned', 'bar', 'Tools shown.')}
          aria-controls={barId}
          aria-expanded={state !== 'tucked'}
          aria-label={handleLabel}
          data-full-view-handle=""
        >
          <Icon name="chevsU" size={phone ? 18 : 14} />
          {props.draft && <span className="ib-fvhandle-w">Draft</span>}
          {count > 0 && (
            <span key={bump} className={`ib-fvhandle-n${bump ? ' ib-bump' : ''}`}>
              <Icon name="comment" size={phone ? 14 : 12} />
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
              aria-label={commentsLabel(comments.count, comments.earlier ?? 0)}
              data-full-view-comments=""
            >
              <Icon name="comment" size={iconSize} />
              <CommentCount count={comments.count} earlier={comments.earlier ?? 0} phone={phone} bump={bump} />
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
                  ? `${position.index + 1}/${position.total}: ${position.noun ?? 'file'} ${position.index + 1} of ${position.total}, ${position.name}. Show every file`
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
        {props.ask}
        {props.more}
        {props.leave.kind === 'exit' && leaveButton}
        {props.onExitFull && props.leave.kind === 'exit' && !phone && (
          // Its tooltip says Esc, so one Esc on it leaves (the tooltip does not keep that press).
          <Tip text={props.exitCloses ? 'Back to the thread' : 'Exit full screen'} keys={props.exitCloses ? [EXIT_KEYS, FULL_KEYS] : EXIT_KEYS} phone={phone} passEscape>
            <button
              type="button"
              className="ib-fvb"
              onClick={props.onExitFull}
              aria-label={props.exitCloses ? 'Back to the thread' : 'Exit full screen'}
              aria-keyshortcuts={exitKeys}
              data-full-view-close=""
            >
              <Icon name="x" size={iconSize} />
            </button>
          </Tip>
        )}
        <Tip text="Hide tools" note="Into the bottom right corner" keys={props.chord ? TOOLS_KEYS : null} phone={phone}>
          <button
            type="button"
            ref={hideRef}
            className="ib-fvb ib-fvhide"
            onClick={() => set('tucked', 'handle', HIDDEN_SAYING)}
            aria-label="Hide tools"
            aria-description={props.chord ? `Shortcut: ${formatShortcutBindingText(props.chord)}` : undefined}
            data-full-view-hide="hide"
          >
            <Icon name="chevsR" size={iconSize} />
          </button>
        </Tip>
      </div>
    </div>
  );
});
