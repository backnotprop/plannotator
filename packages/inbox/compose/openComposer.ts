import { useEffect, useRef } from 'react';
import type { ComposeRequest } from './ComposeDialog';

export interface ComposerPrefill {
  subject?: string;
  body: string;
  files?: readonly File[];
  to?: 'pick' | 'new' | { session: string };
}

export const OPEN_COMPOSER_EVENT = 'plannotator-inbox:open-composer';

export function openComposer(prefill: ComposerPrefill): void {
  window.dispatchEvent(new CustomEvent<ComposerPrefill>(OPEN_COMPOSER_EVENT, { detail: prefill }));
}

export function composeRequestOf(prefill: ComposerPrefill, lastAgent: string | null): ComposeRequest {
  const to = prefill.to ?? 'pick';
  return {
    body: prefill.body,
    ...(prefill.subject ? { threadName: prefill.subject } : {}),
    ...(prefill.files?.length ? { files: prefill.files } : {}),
    ...(to === 'pick' ? { pickTo: true } : to === 'new' ? { launch: { agent: lastAgent } } : { session: to.session }),
  };
}

export function useComposerOpener(open: (request: ComposeRequest) => void, lastAgent: string | null): void {
  const latest = useRef({ open, lastAgent });
  latest.current = { open, lastAgent };
  useEffect(() => {
    const onOpen = (event: Event) => {
      const prefill = (event as CustomEvent<ComposerPrefill>).detail;
      if (!prefill || typeof prefill.body !== 'string') return;
      latest.current.open(composeRequestOf(prefill, latest.current.lastAgent));
    };
    window.addEventListener(OPEN_COMPOSER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMPOSER_EVENT, onOpen);
  }, []);
}
