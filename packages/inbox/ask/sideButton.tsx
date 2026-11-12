import { createContext, useContext, type ReactNode } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import { HostMark, hostHasMark } from '@plannotator/ui/components/inbox-thread/icons';

export interface SideButton {
  icon?: ReactNode;
  label: string;
}

const PLAIN: SideButton = { label: 'Side chat' };

function agentName(host: string): string | null {
  if (host === 'claude-code' || host === 'claude' || host === 'claude-app') return 'Claude';
  return INBOX_HOST_NAMES[host] ?? null;
}

export function sideButtonFor(host: string | null | undefined): SideButton {
  if (!host || !hostHasMark(host)) return PLAIN;
  const name = agentName(host);
  return { icon: <HostMark host={host} />, label: name ? `Side chat with ${name}` : PLAIN.label };
}

export const SideButtonContext = createContext<SideButton | undefined>(undefined);

export const useSideButton = (): SideButton | undefined => useContext(SideButtonContext);
