import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { FILE_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, mainWidthOf, paneGutters } from '../stack';
import { useSwarmSwitch } from './swarmOn';
import { shareThreadSwarm } from './swarmThreadShare';
import { GhostButton } from './GhostButton';
import { GhostPane } from './GhostPane';
import { SwarmSummary } from './SwarmSummary';
import type { SwarmRemoveHost } from './swarmRemove';

/**
 * Whether the ghost pane covers its thread instead of opening beside it: on the rule an open file follows (stack.ts),
 * the thread's 440 px column and a 480 px pane must both fit the room the list and its panes share (the list itself
 * steps aside while the pane is open, swarm.css). Measured before paint and on every resize while it is open.
 */
function useGhostCovers(active: boolean): boolean {
  const [covers, setCovers] = useState(false);
  useLayoutEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const root = document.querySelector<HTMLElement>('.pn-inbox');
    if (!root) return;
    const measure = () => setCovers(mainWidthOf(root) - paneGutters(root) < THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH);
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [active]);
  return active && covers;
}

/**
 * A swarm thread's pieces in its pane (docs/agent-guides/inbox-swarm.md; approval "inbox-swarm-thread-ui"), only while
 * Swarm is on (swarmOn.ts) and the thread is a swarm (its read's `swarm`): the Ghost button for the top bar, the
 * summary row for the line under the title, and the ghost pane beside the thread. Off, or not a swarm: all null, and
 * the thread is drawn as before. ThreadPane only places them.
 */
export function useThreadSwarm(input: {
  thread: { thread_id: string; swarm?: InboxThreadSwarm };
  /** The thread's title, as its bar shows it. */
  title: string;
  phone: boolean;
  /** A file is open beside the thread: the ghost pane gives way to it, and opening the ghost pane closes it. */
  fileOpen: boolean;
  closeFile: () => void;
  /** The thread's toast (Remove's, with Undo). */
  onToast?: SwarmRemoveHost['onToast'];
  /** Read the thread again (after Add an agent or Remove). */
  changed?: SwarmRemoveHost['changed'];
}): { open: boolean; beside: boolean; button: ReactNode; row: ReactNode; pane: ReactNode } {
  const switchOn = useSwarmSwitch();
  const swarm = switchOn ? (input.thread.swarm ?? null) : null;
  const threadId = input.thread.thread_id;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [threadId]);
  useEffect(() => {
    if (input.fileOpen) setOpen(false);
  }, [input.fileOpen]);
  const shown = !!swarm && open;
  const covers = useGhostCovers(shown && !input.phone);
  const close = useCallback(() => setOpen(false), []);
  const show = () => {
    if (input.fileOpen) input.closeFile();
    setOpen(true);
  };
  // The plan card inside a message reads this read (swarmThreadShare.ts), and its Ghost thread opens the pane.
  const showRef = useRef(show);
  showRef.current = show;
  const openGhost = useCallback(() => showRef.current(), []);
  useLayoutEffect(() => {
    shareThreadSwarm(threadId, swarm ? { swarm, openGhost, phone: input.phone } : null);
  }, [threadId, swarm, openGhost, input.phone]);
  useLayoutEffect(() => () => shareThreadSwarm(threadId, null), [threadId]);
  if (!swarm) return { open: false, beside: false, button: null, row: null, pane: null };
  return {
    open: shown,
    beside: shown && !input.phone && !covers,
    button: <GhostButton unread={swarm.ghost_unread ?? 0} open={shown} onToggle={() => (shown ? close() : show())} />,
    row: <SwarmSummary threadId={threadId} swarm={swarm} phone={input.phone} host={{ onToast: input.onToast, changed: input.changed }} onGhost={show} />,
    pane: shown ? <GhostPane threadId={threadId} title={input.title} swarm={swarm} phone={input.phone} full={input.phone || covers} onClose={close} /> : null,
  };
}
