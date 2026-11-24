import { lazy, type ReactNode } from 'react';
import { NativeDiagramBlockContext } from './nativeDiagramEnabled';

const NativeDiagramBlock = lazy(async () => ({
  default: (await import('./NativeDiagramBlock')).NativeDiagramBlock,
}));

/** Opt this host's Viewers into native diagram review. */
export function NativeDiagramProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  return <NativeDiagramBlockContext.Provider value={enabled ? NativeDiagramBlock : null}>
    {children}
  </NativeDiagramBlockContext.Provider>;
}
