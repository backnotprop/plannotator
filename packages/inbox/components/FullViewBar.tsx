import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { formatShortcutBindingText } from '@plannotator/ui/shortcuts';
import { inboxFileViewerShortcuts } from '../shortcuts/fileViewer.shortcuts';
import { shortcutAria, TipKeys, type ShortcutRef } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';

const EXIT_KEYS: ShortcutRef = { scope: inboxFileViewerShortcuts, action: 'escape' };
const FULL_KEYS: ShortcutRef = { scope: inboxThreadShortcuts, action: 'fullScreen' };
const TOOLS_KEYS: ShortcutRef = { scope: inboxFileViewerShortcuts, action: 'toggleTools' };
const exitKeys = shortcutAria(EXIT_KEYS);
import { modKey } from '@plannotator/ui/utils/platform';
import { Icon } from '../icons';
import { CommentCount, commentsLabel } from './EarlierSection';
import { Tip as HoverTip } from './Tip';

export type ToolbarState = 'pinned' | 'tucked';

export interface FullViewBarProps {
  phone: boolean;
  state: ToolbarState;
  onState: (next: ToolbarState) => void;
  announce: (text: string) => void;
  armed: boolean;
  onToggleArmed?: () => void;
  comments: {
    count: number;
    earlier?: number;
    open: boolean;
    controls: string;
    onToggle: () => void;
    buttonRef: RefObject<HTMLButtonElement | null>;
  } | null;
  handleCount: number;
  changed: boolean;
  draft?: boolean;
  commentDraft?: boolean;
  restoreTarget?: () => HTMLElement | null;
  position: {
    index: number;
    total: number;
    name: string;
    noun?: 'file' | 'option';
    open: boolean;
    peekId: string;
    onOpenChange: (open: boolean) => void;
    renderPeek?: (close: (reason: 'key' | 'outside') => void) => ReactNode;
  } | null;
  reuse?: ReactNode;
  more: ReactNode;
  moreOpen: boolean;
  leave: { kind: 'exit' | 'back'; onLeave: () => void };
  onExitFull?: () => void;
  exitCloses?: boolean;
  chord: string | null;
}

export interface FullViewBarHandle {
  toggle: () => void;
  hide: () => void;
}

function Tip({ text, note, keys, phone, passEscape, children }: { text: string; note?: string; keys?: ShortcutRef | readonly ShortcutRef[] | null; phone: boolean; passEscape?: boolean; children: React.ReactElement }) {
  const refs = keys ? (Array.isArray(keys) ? keys : [keys as ShortcutRef]) : [];
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
const HIDDEN_SAYING = 'Tools hidden. They are in the bottom right corner.';
export const GATHERED =
  '.ib-fvbar, .ib-fcomp, .ib-fcomp-pillwrap, .ib-imgbar, .ib-imgshowing, .ib-toolstrip, .ib-contents-open, .pn-contents-rail, .ib-drawer .ib-apanel, .ib-sizecorner';
const focusGathers = () => document.activeElement instanceof Element && document.activeElement.closest(GATHERED) !== null;

export const FullViewBar = forwardRef<FullViewBarHandle, FullViewBarProps>(function FullViewBar(props, ref) {
  const { phone, comments, position, state } = props;
  const barId = `ib-fvbar-${useId().replace(/:/g, '')}`;
  const barRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const posRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<'handle' | 'bar' | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const restoreRef = useRef(props.restoreTarget);
  restoreRef.current = props.restoreTarget;

  const set = (next: ToolbarState, focus: 'handle' | 'bar' | null = null, saying?: string) => {
    pendingFocus.current = focus;
    props.onState(next);
    if (saying) props.announce(saying);
    if (next === stateRef.current) applyFocus();
  };
  const setRef = useRef(set);
  setRef.current = set;

  const applyFocus = () => {
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    if (focus === 'handle') handleRef.current?.focus({ preventScroll: true });
    else if (focus === 'bar') (restoreRef.current?.() ?? hideRef.current)?.focus({ preventScroll: true });
  };
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
        if (stateRef.current === 'pinned') setRef.current('tucked', focusGathers() ? 'handle' : null, HIDDEN_SAYING);
        else setRef.current('pinned', null, 'Tools shown.');
      },
      hide: () => setRef.current('tucked', 'handle', HIDDEN_SAYING),
    }),
    [],
  );

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
    if (reason === 'outside' && !phone) refocus.current = false;
    position?.onOpenChange(false);
  };

  const count = props.handleCount;
  const lastCount = useRef(count);
  const [bump, setBump] = useState(0);
  const drawerOpen = comments?.open ?? false;
  useEffect(() => {
    if (count > lastCount.current && !drawerOpen) setBump((n) => n + 1);
    lastCount.current = count;
  }, [count, drawerOpen]);
  const handleLabel = `Show tools${props.commentDraft ? ', comment not sent' : ''}${props.draft ? ', reply draft' : ''}${count ? `, ${plural(count, 'comment')}` : ''}${props.changed ? ', file changed since sent' : ''}`;
  const iconSize = phone ? 18 : 15;

  const exit = props.leave.kind === 'exit';
  const leaveButton = (
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
      className={`ib-fvdock${phone ? ' ib-fvdock-phone' : ''}`}
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
          <span className="ib-fvhandle-arrows">
            <Icon name="chevsU" size={phone ? 18 : 14} />
            {props.commentDraft && <span className="ib-fvhandle-cdot" aria-hidden="true" data-full-view-comment-dot="" />}
          </span>
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
        {props.reuse}
        {comments && (
          <Tip text={comments.open ? 'Close the comments' : 'Comments'} phone={phone}>
            <button
              type="button"
              ref={comments.buttonRef}
              className={`ib-fvb ib-fvcount${comments.count === 0 ? ' ib-zero' : ''}${comments.open ? ' ib-open' : ''}`}
              onClick={comments.onToggle}
              onKeyDown={(event) => {
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
        {props.more}
        {props.leave.kind === 'exit' && leaveButton}
        {props.onExitFull && props.leave.kind === 'exit' && !phone && (
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
