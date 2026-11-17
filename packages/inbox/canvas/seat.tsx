/**
 * The thread canvas in one thread pane (ThreadSlot.tsx): what ThreadPane draws of it, all null while the canvas is off
 * (config.json `inboxCanvas`; the window learns it from the settings, `canvas: { on }`). Off, a thread shows no
 * button, no card, no chip, and an address with `&canvas` opens the thread alone.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import type { Route } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import { agentName } from '../format';
import { CanvasPane } from './CanvasPane';
import { CanvasButton, CanvasCard, CanvasMarksChip, canvasCardsByMessage, canvasMarksFeedback } from './parts';
import { useThreadCanvas } from './useThreadCanvas';

export interface ThreadCanvasSeat {
  /** The header's button. */
  button: ReactNode;
  /** The canvas is open beside the thread (it takes a file's place). */
  open: boolean;
  /** Open full screen: the thread's floating reply box goes over it. */
  full: boolean;
  /** The pane, given the floating reply box for full screen (null beside the thread). */
  pane: (composer: ReactNode) => ReactNode;
  /** The preview card under a message that drew a version, else null. */
  cardFor: (messageId: string) => ReactNode;
  /** The person's marks since the agent's latest version, while not removed from the reply nor sent in one. */
  marks: { chip: ReactNode; feedback: string } | null;
}

const dismissedKey = (threadId: string) => `plannotator-canvas-marks:${threadId}`;
const readDismissed = (threadId: string): string | null => {
  try {
    return localStorage.getItem(dismissedKey(threadId));
  } catch {
    return null;
  }
};

export function useThreadCanvasSeat(input: { thread: InboxThread | null; on: boolean; route: Route; phone: boolean; go: (next: Route) => void; close: (next: Route) => void }): ThreadCanvasSeat | null {
  const { thread, on, route, phone, go, close } = input;
  const threadId = thread?.thread_id ?? null;
  const canvas = useThreadCanvas(on ? threadId : null, on);
  const { resolvedMode } = useTheme();
  const [dismissed, setDismissed] = useState<{ thread: string; sig: string | null } | null>(null);
  const dismissedSig = threadId ? (dismissed?.thread === threadId ? dismissed.sig : readDismissed(threadId)) : null;
  const dismiss = useCallback(
    (sig: string) => {
      if (!threadId) return;
      try {
        localStorage.setItem(dismissedKey(threadId), sig);
      } catch {
        // Kept for this window only.
      }
      setDismissed({ thread: threadId, sig });
    },
    [threadId],
  );

  const wire = canvas.wire;
  const cards = useMemo(() => (thread && wire ? canvasCardsByMessage(thread.messages, wire.versions) : new Map()), [thread, wire]);
  if (!on || !thread || !threadId) return null;

  const open = route.thread === threadId && !!route.canvas && !route.file;
  const full = open && (phone || route.canvas!.view === 'full');
  const agentAuthor = [...thread.messages].reverse().find((m) => m.author.kind === 'agent')?.author ?? thread.messages[0]!.author;
  const agent = agentName(agentAuthor);
  const openAt = (version: number | null) => go({ ...route, canvas: { view: route.canvas?.view ?? 'side', version }, file: null, ref: null, artifacts: false, links: false, shape: null });
  const latestAgent = wire?.versions.filter((v) => v.by === 'agent').at(-1)?.n ?? null;
  const lines = wire?.marks ?? [];
  const sig = lines.join('\n');
  const feedback = canvasMarksFeedback(lines);
  // Sent already: a reply of the person's carries these very marks (from this window or another device).
  const sentBefore = lines.length > 0 && thread.messages.some((m) => m.author.kind !== 'agent' && m.body.includes(feedback));

  return {
    open,
    full,
    button: <CanvasButton open={open} onToggle={() => (open ? close({ ...route, canvas: null }) : openAt(null))} />,
    pane: (composer) =>
      open ? (
        <CanvasPane
          threadId={threadId}
          canvas={canvas}
          view={route.canvas!.view}
          version={route.canvas!.version}
          phone={phone}
          theme={resolvedMode === 'dark' ? 'dark' : 'light'}
          agent={agent}
          projectName={thread.project?.name ?? null}
          onView={(view) => writeRoute({ ...route, canvas: { ...route.canvas!, view } }, { replace: true })}
          onVersion={(n) => (n ? go({ ...route, canvas: { ...route.canvas!, version: n } }) : writeRoute({ ...route, canvas: { ...route.canvas!, version: null } }, { replace: true }))}
          onClose={() => close({ ...route, canvas: null })}
          composer={composer}
        />
      ) : null,
    cardFor: (messageId) => {
      const v = cards.get(messageId);
      if (!v) return null;
      const latest = v.n === latestAgent;
      const showing = open && (route.canvas!.version ? route.canvas!.version === v.n : latest);
      return <CanvasCard threadId={threadId} version={v} latest={latest} showing={showing} onOpen={() => openAt(latest ? null : v.n)} />;
    },
    marks:
      lines.length > 0 && sig !== dismissedSig && !sentBefore
        ? { chip: <CanvasMarksChip lines={lines} agent={agent} onRemove={() => dismiss(sig)} />, feedback }
        : null,
  };
}
