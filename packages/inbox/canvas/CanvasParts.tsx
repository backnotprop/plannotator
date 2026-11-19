/**
 * A thread's canvas in the Inbox window: the Sketch button (the thread's
 * header and the reply box), the quiet mark a thread with a canvas carries
 * (its header button and its list row), and the layer the editor is drawn in.
 *
 * The canvas takes the whole window, as Excalidraw does on its own site: its
 * tools across the top, its style panel at the left edge beside the drawing
 * rather than over a narrow pane's middle. The thread is one press away
 * (the layer's Thread button). The layer is a `<dialog open>`: every Inbox key
 * handler leaves a dialog's keys to it (shortcuts/guards.ts `modalOpen`), so a
 * letter pressed while drawing is Excalidraw's tool, never the thread's Reply.
 *
 * The editor itself is the lazy `#canvas-board` chunk; a person who never
 * presses Sketch loads none of it. This file's few styles are inline for that
 * reason too: the window's stylesheet does not grow.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CanvasBoardPart, PanePart } from '../lazyParts';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { canvasMarkOf, subscribeCanvasMarks, type CanvasMark, type CanvasReply } from './canvasApi';

const CanvasBoard = CanvasBoardPart.Part;

/** When the press that opens a canvas happened, for the time it takes to be ready (`canvas:ready`, CanvasBoard.tsx). */
function markOpen(): void {
  try {
    performance.clearMarks('canvas:open');
    performance.clearMeasures('canvas:ready');
    performance.mark('canvas:open');
  } catch {
    // No timing in this browser.
  }
}

/** A thread's canvas mark: nothing while it has no canvas (or an empty one). */
export function useCanvasMark(threadId: string | null): CanvasMark | undefined {
  return useSyncExternalStore(subscribeCanvasMarks, () => (threadId ? canvasMarkOf(threadId) : undefined));
}

const DOT: CSSProperties = { position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: 3, pointerEvents: 'none' };

/** Opens and closes the thread's canvas. `where`: the thread's header (an icon, with the canvas's mark) or the reply box's row. */
export function SketchButton({ threadId, open, onToggle, where, size = 16 }: { threadId: string; open: boolean; onToggle: () => void; where: 'header' | 'reply'; size?: number }) {
  const mark = useCanvasMark(where === 'header' ? threadId : null);
  const press = () => {
    if (!open) {
      markOpen();
      // The chunk starts to arrive with the press, before the layer mounts.
      void CanvasBoardPart.preload().catch(() => {});
    }
    onToggle();
  };
  if (where === 'reply') {
    return (
      <Tip content="Sketch">
        <button type="button" className="ib-ricon" aria-label="Sketch" data-reply-sketch="" onClick={press}>
          <Icon name="pen" size={size} />
        </button>
      </Tip>
    );
  }
  const tip = mark?.changed ? 'Canvas, changed by an agent' : mark ? 'Canvas' : 'Sketch';
  return (
    <Tip content={tip}>
      <button
        type="button"
        className={`ib-iconbtn${open ? ' ib-on' : ''}`}
        style={{ position: 'relative' }}
        aria-label={tip}
        aria-pressed={open}
        data-thread-sketch=""
        data-canvas-mark={mark ? (mark.changed ? 'changed' : 'has') : undefined}
        onClick={press}
      >
        <Icon name="pen" size={size} />
        {mark && <span aria-hidden="true" style={{ ...DOT, background: mark.changed ? 'var(--primary)' : 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)' }} />}
      </button>
    </Tip>
  );
}

/** A list row's canvas mark, beside its other marks: a small pen, in the accent colour when an agent changed the canvas since the person looked. */
export function RowCanvasMark({ threadId }: { threadId: string }) {
  const mark = useCanvasMark(threadId);
  if (!mark) return null;
  return (
    <span
      role="img"
      aria-label={mark.changed ? 'Canvas, changed by an agent' : 'Canvas'}
      title={mark.changed ? 'Canvas, changed by an agent' : 'Canvas'}
      data-row-canvas={mark.changed ? 'changed' : 'has'}
      style={{ display: 'inline-flex', flex: 'none', alignItems: 'center', marginLeft: 6, color: mark.changed ? 'var(--primary)' : 'var(--muted-foreground)', opacity: mark.changed ? 1 : 0.7 }}
    >
      <Icon name="pen" size={13} />
    </span>
  );
}

const WINDOW: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 45,
  width: '100vw',
  height: '100dvh',
  maxWidth: 'none',
  maxHeight: 'none',
  margin: 0,
  padding: 0,
  border: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--background)',
  color: 'var(--foreground)',
  overflow: 'hidden',
};
const HEAD: CSSProperties = { touchAction: 'none', flex: 'none', display: 'flex', alignItems: 'center', gap: 6, height: 52, padding: '0 10px 0 6px', boxShadow: '0 1px 0 color-mix(in oklab, var(--foreground) 9%, transparent)' };
const BACK: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, height: 44, minWidth: 44, padding: '0 10px 0 6px', border: 0, borderRadius: 9, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 14, fontWeight: 550, cursor: 'pointer', flex: 'none' };
const TITLE: CSSProperties = { flex: 1, minWidth: 0, margin: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted-foreground)' };

/** A thread's title as the canvas's layer names it: one line, at most this long (the header cuts what does not fit and keeps the whole in its tip). */
export const CANVAS_TITLE_MAX = 120;
const titleShown = (subject: string) => {
  const line = Array.from(subject.replace(/\s+/g, ' ').trim());
  return line.length > CANVAS_TITLE_MAX ? `${line.slice(0, CANVAS_TITLE_MAX - 1).join('')}…` : line.join('');
};

/** The canvas, over the whole window. */
export function CanvasLayer({
  threadId,
  subject,
  dark,
  agent,
  agentMark,
  received,
  draft,
  onWords,
  onSend,
  onClose,
}: {
  threadId: string;
  subject: string;
  dark: boolean;
  agent: string | null;
  /** That agent's icon, and whether the person's newest reply reached a running session of it. */
  agentMark?: ReactNode;
  received?: boolean;
  /** The reply box's words when the canvas opened: the bar starts from them. */
  draft: string;
  /** The bar's words as they change, so they go back to the reply box when the canvas closes. */
  onWords: (words: string) => void;
  onSend: (reply: CanvasReply) => void;
  onClose: () => void;
}) {
  // A chunk that could not arrive says so in the layer; the next open asks for it again.
  const failed = useCallback(() => CanvasBoardPart.retry(), []);
  const back = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    back.current?.focus({ preventScroll: true });
    // The Inbox behind the canvas takes no focus and no keys while the canvas is open: Tab stays in the layer.
    const behind = document.getElementById('root');
    const wasInert = behind?.hasAttribute('inert') ?? true;
    if (behind && !wasInert) behind.setAttribute('inert', '');
    return () => {
      if (behind && !wasInert) behind.removeAttribute('inert');
      // Focus goes back to the button that opened the canvas.
      const el = opener.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-thread-sketch]')?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog open role="dialog" aria-modal="true" aria-label={`Canvas of ${titleShown(subject)}`} style={WINDOW} data-canvas-layer={threadId}>
      {/* The Inbox's own scope, so its icons and buttons look here as they do in the window (the layer sits on the page's body). */}
      <div className="pn-inbox" style={{ display: 'contents' }}>
      <header style={HEAD}>
        <button type="button" ref={back} style={BACK} onClick={onClose} data-canvas-back="" aria-label="Back to the thread">
          <Icon name="chevL" size={16} />
          Thread
        </button>
        <h2 style={TITLE} title={subject}>{titleShown(subject)}</h2>
        <Tip content="Close">
          <button type="button" className="ib-iconbtn" style={{ minWidth: 30, minHeight: 30, flex: 'none' }} aria-label="Close the canvas" onClick={onClose} data-canvas-close="">
            <Icon name="x" size={16} />
          </button>
        </Tip>
      </header>
      <PanePart loading={<div style={{ flex: 1 }} aria-busy="true" />} onFailed={failed}>
        <CanvasBoard threadId={threadId} dark={dark} agent={agent} agentMark={agentMark} received={received} draft={draft} onWords={onWords} onSend={onSend} />
      </PanePart>
      </div>
    </dialog>,
    document.body,
  );
}
