/**
 * The floating chat window: the box, drag-move by the header, double-click
 * re-dock, top-left drag and keyboard resize, minimize, fullscreen (and the
 * forced fullscreen of a frame too narrow to float in), the optional launcher
 * slot, the opt-in keyboard map and the focus return on minimize.
 *
 * It renders from ChatWindowStore alone. The host passes what the header
 * holds, what sits under it, and the body and composer. The window is
 * `absolute`, so its parent must be a positioned element: that parent is the
 * frame it floats in and is clamped to.
 */

import { ChevronDown, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type * as React from 'react';

import { cn } from '../../lib/utils';
import { isMac } from '../../utils/platform';
import { Button } from '../ui/button';
import { CHAT_ICON_BUTTON, floatingDialogChrome } from './chatRecipes';
import {
  CHAT_WINDOW_DEFAULT,
  CHAT_WINDOW_FRAME_MARGIN,
  CHAT_WINDOW_MIN,
  type ChatWindowStore,
} from './chatWindowStore';

/** The mark a launcher wears: the focus return finds it by this attribute. */
export const CHAT_LAUNCHER_SELECTOR = '[data-chat-launcher]';

/** What the frame tells its slots on every render. */
export interface ChatFrameState {
  /** Fullscreen, by the person's toggle or forced by a narrow frame. */
  readonly fullscreen: boolean;
  /** The floating width, for slots that slim down when narrow. */
  readonly width: number;
}

/** The host's extras on the window's root (a drop target). */
export interface ChatFrameRootProps {
  readonly 'data-drop-active'?: string | undefined;
  readonly onDragOver?: React.DragEventHandler<HTMLElement>;
  readonly onDragLeave?: React.DragEventHandler<HTMLElement>;
  readonly onDrop?: React.DragEventHandler<HTMLElement>;
}

/** The words the frame draws. */
export interface ChatFrameLabels {
  readonly fullscreen: string;
  readonly exitFullscreen: string;
  readonly minimize: string;
  readonly close: string;
  readonly resize: string;
  readonly dragHint: string;
}

const DEFAULT_LABELS: ChatFrameLabels = {
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  minimize: 'Minimize',
  close: 'Close',
  resize: 'Resize the chat window. Arrow keys resize; Home restores the default size.',
  dragHint: 'Drag to move · double-click to re-dock',
};

export interface ChatFrameProps {
  store: ChatWindowStore;
  /** The window's accessible name. */
  label: string;
  /** The host's handle on the window's root (it is also the frame's own). */
  windowRef?: React.RefObject<HTMLElement | null>;
  /** Extra classes on the root, after the chrome. */
  className?: string | false | undefined;
  rootProps?: ChatFrameRootProps;
  /** The header's left side, inside the drag row (a mark and a title, or tabs). */
  header?: (frame: ChatFrameState) => React.ReactNode;
  /** Under the drag row, still in the header (notices, a strip). */
  headerBelow?: React.ReactNode;
  /** The body and the composer. None: the host has nothing to show yet, so
   * the open frame renders nothing. */
  children?: (frame: ChatFrameState) => React.ReactNode;
  /** Runs after the minimize button has minimized the store. */
  onMinimize?: () => void;
  /** Passing this draws the × button. What closing means is the host's. */
  onClose?: () => void;
  /** False: the header does not move the window and double-click does nothing. */
  allowDrag?: boolean;
  /** False: no toggle, and the store's fullscreen flag is ignored. A narrow
   * frame still forces fullscreen, because the window cannot float there. */
  allowFullscreen?: boolean;
  labels?: Partial<ChatFrameLabels>;
}

export function ChatFrame({
  store,
  label,
  windowRef,
  className,
  rootProps,
  header,
  headerBelow,
  children,
  onMinimize,
  onClose,
  allowDrag = true,
  allowFullscreen = true,
  labels,
}: ChatFrameProps) {
  'use no memo'; // reads mutable store state; compiler memoization would go stale
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const ownRef = useRef<HTMLElement | null>(null);
  const rootRef = windowRef ?? ownRef;
  const shown = !store.minimized && children !== undefined;
  const words = { ...DEFAULT_LABELS, ...labels };

  /** The frame the window floats in. An unmeasurable frame reads as unbounded:
   * the min clamps still apply, and the real frame re-clamps on the next measure. */
  const frameBox = (): { width: number; height: number } => {
    const frame = rootRef.current?.parentElement;
    const width = frame?.clientWidth ?? 0;
    const height = frame?.clientHeight ?? 0;
    return {
      width: width > 0 ? width : Number.POSITIVE_INFINITY,
      height: height > 0 ? height : Number.POSITIVE_INFINITY,
    };
  };

  /** The largest size the frame allows from where the window is anchored. */
  const maxSize = (): { width: number; height: number } => {
    const frame = frameBox();
    return {
      width: Math.min(frame.width - CHAT_WINDOW_FRAME_MARGIN * 2, frame.width - store.winRight),
      height: Math.min(frame.height - CHAT_WINDOW_FRAME_MARGIN * 2, frame.height - store.winBottom),
    };
  };

  // A floating window cannot fit where the free width is under the minimum, so
  // a narrow frame forces fullscreen, and a frame that shrinks re-clamps the
  // geometry so the window never strands off screen.
  const [frameWidth, setFrameWidth] = useState<number | null>(null);
  useEffect(() => {
    const frame = rootRef.current?.parentElement;
    if (frame == null || typeof ResizeObserver !== 'function') return;
    const measure = (): void => {
      // A display: none frame measures 0: unknown, not a reason to force fullscreen.
      setFrameWidth(frame.clientWidth > 0 ? frame.clientWidth : null);
      store.clampToFrame(frame.clientWidth, frame.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [store, store.minimized, shown, rootRef]);
  const forcedFullscreen =
    frameWidth !== null && frameWidth - CHAT_WINDOW_FRAME_MARGIN * 2 < CHAT_WINDOW_MIN.width;
  const fullscreen = (allowFullscreen && store.fullscreen) || forcedFullscreen;

  // Drag-resize from the top-left grip: the window stays anchored by its
  // bottom-right offsets, so growing pulls the free corner.
  const onResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (fullscreen) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = store.winW;
    const startH = store.winH;
    const max = maxSize();
    const onMove = (move: PointerEvent): void => {
      store.setWindowSize(
        Math.max(CHAT_WINDOW_MIN.width, Math.min(max.width, startW + (startX - move.clientX))),
        Math.max(CHAT_WINDOW_MIN.height, Math.min(max.height, startH + (startY - move.clientY))),
      );
    };
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  };

  // Keyboard resize on the focused grip: arrows resize, Shift for big steps,
  // Home restores the default size. The grip sits top-left, so Left and Up
  // grow the window and Right and Down shrink it.
  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (fullscreen) return;
    if (event.key === 'Home') {
      event.preventDefault();
      store.setWindowSize(CHAT_WINDOW_DEFAULT.width, CHAT_WINDOW_DEFAULT.height);
      return;
    }
    const step = event.shiftKey ? 64 : 16;
    let deltaW = 0;
    let deltaH = 0;
    if (event.key === 'ArrowLeft') deltaW = step;
    else if (event.key === 'ArrowRight') deltaW = -step;
    else if (event.key === 'ArrowUp') deltaH = step;
    else if (event.key === 'ArrowDown') deltaH = -step;
    else return;
    event.preventDefault();
    const max = maxSize();
    store.setWindowSize(
      Math.max(CHAT_WINDOW_MIN.width, Math.min(max.width, store.winW + deltaW)),
      Math.max(CHAT_WINDOW_MIN.height, Math.min(max.height, store.winH + deltaH)),
    );
  };

  // Drag-move by the header, anywhere in the title row that is not a button.
  const dragEnabled = allowDrag && !fullscreen;
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragEnabled) return;
    // A menu opened from the header is a React portal: its rows sit under
    // <body> in the DOM but inside this row in the React tree, so their
    // pointerdown still bubbles here. Taking the drag on one would swallow its
    // click, so a drag starts only from this row's own DOM subtree.
    const target = event.target as Node | null;
    if (target === null || !event.currentTarget.contains(target)) return;
    if ((event.target as HTMLElement).closest('button') !== null) return;
    event.preventDefault();
    const row = event.currentTarget;
    row.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startRight = store.winRight;
    const startBottom = store.winBottom;
    const frame = frameBox();
    const onMove = (move: PointerEvent): void => {
      store.setWindowOffsets(
        Math.max(0, Math.min(frame.width - store.winW, startRight - (move.clientX - startX))),
        Math.max(0, Math.min(frame.height - store.winH, startBottom - (move.clientY - startY))),
      );
    };
    const onUp = (): void => {
      row.removeEventListener('pointermove', onMove);
      row.removeEventListener('pointerup', onUp);
      row.removeEventListener('pointercancel', onUp);
    };
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onUp);
  };

  if (!shown) return null;
  const frame: ChatFrameState = { fullscreen, width: store.winW };

  return (
    <aside
      ref={rootRef}
      aria-label={label}
      data-chat-window
      {...rootProps}
      className={cn(
        'absolute z-40 flex min-h-0 min-w-0 flex-col overflow-hidden',
        floatingDialogChrome,
        'bg-card',
        className,
        fullscreen ? 'inset-0 rounded-none border-none shadow-none' : 'max-h-full max-w-full',
      )}
      style={
        fullscreen
          ? undefined
          : {
              width: store.winW,
              height: store.winH,
              right: store.winRight,
              bottom: store.winBottom,
            }
      }
    >
      {/* The resize grip sits top-left, the window's one free corner. */}
      {!fullscreen && (
        <button
          type="button"
          aria-label={words.resize}
          data-chat-resize-grip
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
          className="absolute left-0 top-0 z-10 flex size-5 cursor-nwse-resize touch-none items-center justify-center rounded-sm text-tertiary hover:bg-surface-hover hover:text-muted-foreground"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M13 3 3 13" />
            <path d="M8 3 3 8" />
          </svg>
        </button>
      )}
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 pb-2 pt-2.5">
        <div
          className={cn('flex items-center gap-1.5 pl-4', dragEnabled && 'cursor-grab touch-none')}
          data-chat-drag-handle={dragEnabled ? '' : undefined}
          onPointerDown={onHeaderPointerDown}
          onDoubleClick={(event) => {
            if (!dragEnabled) return;
            if ((event.target as HTMLElement).closest('button') !== null) return;
            store.resetWindowDock();
          }}
          title={dragEnabled ? words.dragHint : undefined}
        >
          {header?.(frame)}
          <span className="ml-auto flex items-center gap-0.5">
            {/* Forced fullscreen hides the toggle: exiting could not work there. */}
            {allowFullscreen && !forcedFullscreen && (
              <Button
                variant="ghost"
                size="icon"
                className={CHAT_ICON_BUTTON}
                aria-label={store.fullscreen ? words.exitFullscreen : words.fullscreen}
                aria-pressed={store.fullscreen}
                onClick={() => store.toggleFullscreen()}
              >
                {store.fullscreen ? (
                  <Minimize2 aria-hidden="true" className="size-3.5" />
                ) : (
                  <Maximize2 aria-hidden="true" className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className={CHAT_ICON_BUTTON}
              aria-label={words.minimize}
              onClick={() => {
                store.setMinimized(true);
                onMinimize?.();
              }}
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </Button>
            {onClose !== undefined && (
              <Button
                variant="ghost"
                size="icon"
                className={CHAT_ICON_BUTTON}
                aria-label={words.close}
                onClick={onClose}
              >
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            )}
          </span>
        </div>
        {headerBelow}
      </header>
      {children?.(frame)}
    </aside>
  );
}

/** The optional launcher slot: its children, the host's launcher button
 * wearing `data-chat-launcher`, show only while the window is minimized. A
 * host that draws its own launcher never mounts this. */
export function ChatFrameLauncher({
  store,
  children,
}: {
  store: ChatWindowStore;
  children: React.ReactNode;
}) {
  'use no memo'; // reads mutable store state; compiler memoization would go stale
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  if (!store.minimized) return null;
  return children;
}

/**
 * The opt-in keyboard map (raw keydown on window). Nothing listens unless a
 * host calls this. Cmd-J (Ctrl-J off a Mac) summons or minimizes, Shift-Cmd-J
 * toggles fullscreen, Escape minimizes an open window. `onKey` runs first for
 * every other key, so the host can take Escape or its own chords; it answers
 * true when it handled the key. Keep `onKey` and `onMinimize` stable: the
 * listener is re-attached when they change.
 */
export function useChatFrameKeys(
  store: ChatWindowStore,
  {
    summon,
    onKey,
    onMinimize,
  }: {
    /** False: Cmd-J does nothing (the host hides its launcher). */
    summon: boolean;
    onKey?: (event: KeyboardEvent, isMac: boolean) => boolean;
    /** Runs after a key has minimized the store. */
    onMinimize?: () => void;
  },
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'j') {
        if (!summon) return;
        event.preventDefault();
        if (event.shiftKey) {
          store.toggleFullscreen();
          return;
        }
        const minimize = !store.minimized;
        store.setMinimized(minimize);
        if (minimize) onMinimize?.();
        return;
      }
      if (onKey?.(event, isMac) === true) return;
      if (event.key === 'Escape' && !store.minimized) {
        store.setMinimized(true);
        onMinimize?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store, summon, onKey, onMinimize]);
}

/** Minimizing returns focus to the launcher, whatever gesture did it. With no
 * element wearing `data-chat-launcher` there is nothing to focus and nothing
 * happens. Opening lands in the host's composer, which the host does itself. */
export function useChatFrameFocusReturn(store: ChatWindowStore): void {
  const minimized = useSyncExternalStore(
    store.subscribe,
    () => store.minimized,
    () => store.minimized,
  );
  const prevMinimizedRef = useRef(minimized);
  useEffect(() => {
    const wasMinimized = prevMinimizedRef.current;
    prevMinimizedRef.current = minimized;
    if (!minimized || wasMinimized) return;
    // Next frame: the launcher renders in the window's place first. Canceled on
    // unmount, so an orphaned callback never focuses into a dead tree.
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(CHAT_LAUNCHER_SELECTOR)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [minimized]);
}
