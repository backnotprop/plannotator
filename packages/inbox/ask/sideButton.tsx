import { createContext, useContext, type ReactNode } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import { HostMark, hostHasMark } from '@plannotator/ui/components/inbox-thread/icons';

/** How the selection bar draws Side (ui AnnotationToolbar `sideButton`): icon-only, named by its tooltip. */
export interface SideButton {
  /** The glyph; absent: ui's two speech bubbles. */
  icon?: ReactNode;
  /** The tooltip and the accessible name. */
  label: string;
}

/** Side with no agent mark to draw: the two bubbles, "Side chat". */
const PLAIN: SideButton = { label: 'Side chat' };

/** The agent as the tooltip names it: Claude by its own name on every Claude host, the others by their host's name. */
function agentName(host: string): string | null {
  if (host === 'claude-code' || host === 'claude' || host === 'claude-app') return 'Claude';
  return INBOX_HOST_NAMES[host] ?? null;
}

/**
 * Side in the selection bar (approval "inbox-side-button", 2026-11-09): the mark of the agent that owns the
 * thread, the one `HostMark` draws beside its messages, with the tooltip "Side chat with <agent>". A host with
 * no mark of its own, or an owner nobody knows, keeps the two bubbles and "Side chat": never the neutral code
 * glyph, never a blank. A mark whose host has no name here keeps its mark and says "Side chat".
 */
export function sideButtonFor(host: string | null | undefined): SideButton {
  if (!host || !hostHasMark(host)) return PLAIN;
  const name = agentName(host);
  return { icon: <HostMark host={host} />, label: name ? `Side chat with ${name}` : PLAIN.label };
}

/**
 * The open thread's Side button, for the selection bars of its messages and of its open file. Absent (no
 * provider): ui's own Side, the two bubbles and the word.
 */
export const SideButtonContext = createContext<SideButton | undefined>(undefined);

export const useSideButton = (): SideButton | undefined => useContext(SideButtonContext);
