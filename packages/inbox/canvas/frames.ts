/**
 * `event: canvas` (only while the canvas is on, only to a window on this computer): the canvases these threads have
 * changed. `[]`: look again (the server sends it as a window's stream starts, so a reconnect misses nothing).
 */
export const canvasFrameListeners = new Set<(ids: string[]) => void>();

export function subscribeCanvasFrames(listener: (ids: string[]) => void): () => void {
  canvasFrameListeners.add(listener);
  return () => {
    canvasFrameListeners.delete(listener);
  };
}

/**
 * A canvas frame arrived (eventFrames.ts): every open canvas reads again, and this window lays out each agent version
 * waiting for a browser engine, whether or not its canvas is open (layout.ts, loaded on the first frame: a window
 * with the canvas off never hears one, so never loads it).
 */
export function canvasFrameArrived(ids: string[]): void {
  for (const listener of canvasFrameListeners) listener(ids);
  void import('./layout').then((m) => m.layOutPending()).catch(() => {});
}
