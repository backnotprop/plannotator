/** An agent's HTML runs in HtmlViewer's sandboxed srcdoc frame (opaque origin), so it can neither call `receive` nor be relayed here; the shell takes messages from the main frame only. */

import { INBOX_SURFACE_BRIDGE_VERSION, readSurfaceShellMessage, type SurfaceMessage, type SurfaceShellMessage } from '@plannotator/core/inbox-types';

export type ToShell = SurfaceMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

interface ShellChannels {
  webkit?: { messageHandlers?: { plannotatorSurface?: { postMessage: (message: unknown) => void } } };
  plannotatorShell?: { postMessage: (message: string) => void };
}

export function postToShell(message: ToShell): void {
  const shell = window as unknown as ShellChannels;
  const wire = { v: INBOX_SURFACE_BRIDGE_VERSION, ...message };
  if (shell.webkit) {
    shell.webkit.messageHandlers?.plannotatorSurface?.postMessage(wire);
    return;
  }
  shell.plannotatorShell?.postMessage(JSON.stringify(wire));
}

export function listenToShell(onMessage: (message: SurfaceShellMessage) => void): () => void {
  const receive = (value: unknown) => {
    const read = readSurfaceShellMessage(value);
    if (read.ok) onMessage(read.message);
    else postToShell({ type: 'error', code: read.code, message: read.message });
  };
  Object.defineProperty(window, 'plannotatorSurface', { value: Object.freeze({ receive }), configurable: true });
  return () => {
    delete (window as unknown as { plannotatorSurface?: unknown }).plannotatorSurface;
  };
}
