/**
 * A thread's canvas in the Inbox window: the Sketch button (the thread's
 * header and the reply box) and the layer the editor is drawn in, in the
 * thread's pane under its header, where the messages and the reply were. The
 * editor itself is the lazy `#canvas-board` chunk; a person who never presses
 * Sketch loads none of it.
 */
import { useCallback } from 'react';
import { CanvasBoardPart, PanePart } from '../lazyParts';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import type { CanvasReply } from './canvasApi';

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

/** Opens and closes the thread's canvas. `where`: the thread's header (an icon) or the reply box's row. */
export function SketchButton({ open, onToggle, where, size = 16 }: { open: boolean; onToggle: () => void; where: 'header' | 'reply'; size?: number }) {
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
      <Tip content="Sketch on this thread's canvas">
        <button type="button" className="ib-ricon" aria-label="Sketch" data-reply-sketch="" onClick={press}>
          <Icon name="pen" size={size} />
        </button>
      </Tip>
    );
  }
  return (
    <Tip content={open ? 'Back to the messages' : "Sketch on this thread's canvas"}>
      <button type="button" className={`ib-iconbtn${open ? ' ib-on' : ''}`} aria-label="Sketch" aria-pressed={open} data-thread-sketch="" onClick={press}>
        <Icon name="pen" size={size} />
      </button>
    </Tip>
  );
}

/** The canvas, in its thread's pane. */
export function CanvasLayer({ threadId, dark, agent, onSend }: { threadId: string; dark: boolean; agent: string | null; onSend: (reply: CanvasReply) => void }) {
  // A chunk that could not arrive says so in the pane; the next open asks for it again.
  const failed = useCallback(() => CanvasBoardPart.retry(), []);
  return (
    <section className="ib-shape-layer ib-shape-inthread" data-canvas-layer={threadId} aria-label="Canvas">
      <PanePart loading={<div className="ib-shape-loading" aria-busy="true" />} onFailed={failed}>
        <CanvasBoard threadId={threadId} dark={dark} agent={agent} onSend={onSend} />
      </PanePart>
    </section>
  );
}
