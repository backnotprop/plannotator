/**
 * A thread pane's canvas wiring (thread/ThreadSlot.tsx): the pen in the thread's header and the one in its reply
 * box, and the layer the canvas is drawn in. Only while the canvas is on (Settings → Capabilities → Canvas, the
 * Inbox's `settings.canvas`): off, there is no pen and no layer, and nothing of the canvas loads (the pens and the
 * layer are the lazy canvas/CanvasParts.tsx, the editor the lazy `#canvas-board`).
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { inboxAgentName, type InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { HostMark } from '../icons';
import { linkedMachinesWith, machineOf } from '../inboxUrl';
import { CanvasLayerPart, SketchButtonPart } from '../lazyParts';
import { useInboxTheme } from '../theme';
import type { ThreadSlotHost } from '../thread/slotHost';

export interface ThreadCanvas {
  /** The canvas over the whole window, while open. */
  layer: ReactNode;
  /** The thread header's pen (with the canvas's mark), and the reply box's. */
  header: ReactNode;
  reply: ReactNode;
  /** How the canvas's own Send ended: one that stays in the reply box closes the canvas, so the box takes its place. */
  outcome: (outcome: 'sent' | 'held') => void;
}

const SketchButton = SketchButtonPart.Part;
const CanvasLayer = CanvasLayerPart.Part;

export function useThreadCanvas(thread: InboxThread | null, host: ThreadSlotHost, phone: boolean): ThreadCanvas {
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
  const { shown: themeShown } = useInboxTheme();
  // The reply box's words go to the canvas's bar and come back: what the box held when the canvas opened (its saved
  // draft), and the bar's words as the person leaves them.
  const [canvasDraft, setCanvasDraft] = useState('');
  const canvasWords = useRef('');
  const openCanvas = () => {
    if (!canvasFor) return;
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
        />
      </Suspense>
    ) : null;
  const pen = (where: 'header' | 'reply', size: number) =>
    canvasFor ? (
      <Suspense fallback={null}>
        <SketchButton threadId={canvasFor} where={where} open={canvasOn} onToggle={toggleCanvas} size={size} />
      </Suspense>
    ) : null;
  return {
    layer,
    header: pen('header', 17),
    reply: pen('reply', phone ? 20 : 16),
    outcome: (outcome) => {
      if (outcome === 'held') setCanvasOpen(null);
    },
  };
}
