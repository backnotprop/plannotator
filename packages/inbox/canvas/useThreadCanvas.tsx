/**
 * A thread pane's canvas wiring (thread/ThreadSlot.tsx): the canvas button in the thread's header (only once the
 * thread has a canvas), the reply box's + → Canvas (compose/ReplyPlusMenu.tsx), and the layer the canvas is drawn in.
 * The canvas is simply there (no row in Settings); only an Inbox whose `settings.canvas` is not on (config.json
 * `inboxCanvas: false`, or an older Inbox) has none of it, and then nothing of the canvas loads (the header button and
 * the layer are the lazy canvas/CanvasParts.tsx, the editor the lazy `#canvas-board`).
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { inboxAgentName, type InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { HostMark } from '../icons';
import { linkedMachinesWith, machineOf } from '../inboxUrl';
import { CanvasBoardPart, CanvasLayerPart, SketchButtonPart } from '../lazyParts';
import { useInboxTheme } from '../theme';
import type { ThreadSlotHost } from '../thread/slotHost';

export interface ThreadCanvas {
  /** The canvas over the whole window, while open. */
  layer: ReactNode;
  /** The thread header's canvas button (with the canvas's mark): nothing while the thread has no canvas. */
  header: ReactNode;
  /**
   * The reply box's + → Canvas, null where the thread can have no canvas. A thread without one: its canvas opens. A
   * thread with one: the same board opens on a clear spot, and its Send carries only what is drawn on this visit.
   */
  openFromReply: (() => void) | null;
  /** How the canvas's own Send ended: one that stays in the reply box closes the canvas, so the box takes its place. */
  outcome: (outcome: 'sent' | 'held') => void;
}

const SketchButton = SketchButtonPart.Part;
const CanvasLayer = CanvasLayerPart.Part;

export function useThreadCanvas(thread: InboxThread | null, host: ThreadSlotHost): ThreadCanvas {
  // A linked computer's thread too, when that computer has the canvas (mark `canvas`): its scene lives there and every
  // call goes through the forward (canvasApi.ts). An older one has none, and its threads get no pen.
  const machine = thread ? machineOf(thread.thread_id) : null;
  const canvasFor = host.settings?.canvas?.on === true && thread && (!machine || linkedMachinesWith('canvas').includes(machine)) ? thread.thread_id : null;
  // The pens and the layer arrive together while the canvas is on, so a press never waits on Suspense.
  useEffect(() => {
    if (canvasFor) void Promise.all([SketchButtonPart.preload(), CanvasLayerPart.preload()]).catch(() => {});
  }, [canvasFor]);
  const [canvasOpen, setCanvasOpen] = useState<string | null>(null);
  const canvasOn = !!canvasFor && canvasOpen === canvasFor;
  /** This visit came from the reply box's +: the board opens a clear spot if what it reads holds something (canvas/freshVisit.ts). */
  const [fromPlus, setFromPlus] = useState(false);
  const { shown: themeShown } = useInboxTheme();
  // The reply box's words go to the canvas's bar and come back: what the box held when the canvas opened (its saved
  // draft), and the bar's words as the person leaves them.
  const [canvasDraft, setCanvasDraft] = useState('');
  const canvasWords = useRef('');
  const openCanvas = (plus = false) => {
    if (!canvasFor) return;
    setFromPlus(plus);
    setCanvasDraft('');
    canvasWords.current = '';
    setCanvasOpen(canvasFor);
    const id = canvasFor;
    void inboxApi
      .replyDraft(id)
      .then((answer) => {
        const body = answer.draft?.body ?? '';
        if (!body) return;
        canvasWords.current = body;
        setCanvasDraft(body);
      })
      .catch(() => {});
  };
  const closeCanvas = () => {
    const id = canvasOpen;
    setCanvasOpen(null);
    // Words typed (or changed) in the bar and not sent go to the reply box.
    if (id && canvasWords.current !== canvasDraft) host.setCanvasReply({ words: canvasWords.current, threadId: id });
  };
  const toggleCanvas = () => (canvasOn ? closeCanvas() : openCanvas());
  const canvasAgent = thread ? ([...thread.messages].reverse().find((m) => m.author.kind === 'agent')?.author ?? null) : null;
  // The person's newest reply reached a running session (the thread's own delivery mark): the canvas shows the agent at work.
  const canvasLast = thread ? thread.messages[thread.messages.length - 1] : undefined;
  const canvasReceived = !!canvasLast && canvasLast.author.kind === 'person' && canvasLast.delivery?.state === 'delivered';
  const layer =
    canvasOn && canvasFor && thread ? (
      <Suspense fallback={null}>
        <CanvasLayer
          threadId={canvasFor}
          subject={thread.thread_name?.trim() || thread.subject || 'Thread'}
          dark={themeShown === 'dark'}
          agent={canvasAgent ? inboxAgentName(canvasAgent) : null}
          agentMark={canvasAgent && canvasAgent.kind === 'agent' ? <HostMark host={canvasAgent.host} agent={canvasAgent.session} /> : undefined}
          received={canvasReceived}
          draft={canvasDraft}
          onWords={(words) => {
            canvasWords.current = words;
          }}
          onSend={(reply) => {
            // Sent: the bar is empty again, and so is what goes back to the reply box.
            canvasWords.current = '';
            setCanvasDraft('');
            host.setCanvasReply({ words: reply.words, files: reply.files, sketch: reply.sketch, send: true, threadId: canvasFor });
          }}
          onClose={closeCanvas}
          outbox={host.outbox}
          machine={machine ? (host.machines.linked.find((m) => m.id === machine) ?? null) : null}
          fromPlus={fromPlus}
        />
      </Suspense>
    ) : null;
  return {
    layer,
    header: canvasFor ? (
      <Suspense fallback={null}>
        <SketchButton threadId={canvasFor} open={canvasOn} onToggle={toggleCanvas} size={17} />
      </Suspense>
    ) : null,
    openFromReply: canvasFor
      ? () => {
          void CanvasBoardPart.preload().catch(() => {});
          // Whether the canvas holds something is the board's to say, from its own read (the marks may not be in yet).
          openCanvas(true);
        }
      : null,
    outcome: (outcome) => {
      if (outcome === 'held') setCanvasOpen(null);
    },
  };
}
