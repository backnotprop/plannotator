/**
 * Open New message already filled in, from anywhere in the window: a thread name, the words, files, and who it goes
 * to. The person reads it and presses Send; nothing is sent for them. One small piece for every "ask an agent about
 * this" offer ("Animate it" in the agent icon dialog; the errors' "Ask an agent to look" next).
 *
 * A window event, as a failed clone's Change the URL is (`COMPOSE_CLONE_EVENT`), so a caller deep in a dialog needs no
 * prop threaded from App.tsx; App listens once (`useComposerOpener`) and opens compose (compose/ComposeDialog.tsx).
 */
import { useEffect, useRef } from 'react';
import type { ComposeRequest } from './ComposeDialog';

export interface ComposerPrefill {
  /** The new thread's name, as if the person had typed it. */
  subject?: string;
  /** The message's words. */
  body: string;
  /** Files the message starts with (uploaded as a picked file is). */
  files?: readonly File[];
  /**
   * Who it goes to. `pick`: To opens on its own list, the agents running now and "New <agent> session" (the
   * launcher's own choice, with what it offers there). `new`: To reads "New <agent> session", the agent the person
   * started last. `{ session }`: that running agent. Default `pick`.
   */
  to?: 'pick' | 'new' | { session: string };
}

export const OPEN_COMPOSER_EVENT = 'plannotator-inbox:open-composer';

/** Open New message filled in with `prefill`. */
export function openComposer(prefill: ComposerPrefill): void {
  window.dispatchEvent(new CustomEvent<ComposerPrefill>(OPEN_COMPOSER_EVENT, { detail: prefill }));
}

/** The compose request a prefill opens (`lastAgent`: the agent the person started last, for `new`). */
export function composeRequestOf(prefill: ComposerPrefill, lastAgent: string | null): ComposeRequest {
  const to = prefill.to ?? 'pick';
  return {
    body: prefill.body,
    ...(prefill.subject ? { threadName: prefill.subject } : {}),
    ...(prefill.files?.length ? { files: prefill.files } : {}),
    ...(to === 'pick' ? { pickTo: true } : to === 'new' ? { launch: { agent: lastAgent } } : { session: to.session }),
  };
}

/** App.tsx: open compose when anything asks (`open`: App's own openCompose). */
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
