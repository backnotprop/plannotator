/**
 * The surface's end of the bridge (adr/implementation/inbox-mobile.md,
 * section 5; the shapes are `@plannotator/core/inbox-types`'s Surface*).
 *
 * In: the shell calls `window.plannotatorSurface.receive(message)`. Out:
 * `window.webkit.messageHandlers.plannotatorSurface.postMessage(message)`.
 * Nothing else reaches the shell: an agent's HTML runs in HtmlViewer's
 * sandboxed srcdoc frame (an opaque origin), so it can neither call
 * `receive` on this window nor be relayed here, and the shell takes messages
 * from the main frame only.
 */

import { INBOX_SURFACE_BRIDGE_VERSION, readSurfaceShellMessage, type SurfaceMessage, type SurfaceShellMessage } from '@plannotator/core/inbox-types';

/** A message to the shell, without its `v` (added here). */
export type ToShell = SurfaceMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

interface WebkitHandlers {
  webkit?: { messageHandlers?: { plannotatorSurface?: { postMessage: (message: unknown) => void } } };
}

export function postToShell(message: ToShell): void {
  const handler = (window as unknown as WebkitHandlers).webkit?.messageHandlers?.plannotatorSurface;
  // Outside a shell (a desktop browser opening the file) there is nobody to tell.
  handler?.postMessage({ v: INBOX_SURFACE_BRIDGE_VERSION, ...message });
}

/**
 * Install `window.plannotatorSurface.receive`. A message this surface cannot
 * read is answered with `error` and goes no further.
 */
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
