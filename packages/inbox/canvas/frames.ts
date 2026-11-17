/** `event: canvas` (only while the canvas is on): the canvases these threads have changed. `[]`: a reconnect, read again. */
export const canvasFrameListeners = new Set<(ids: string[]) => void>();

export function subscribeCanvasFrames(listener: (ids: string[]) => void): () => void {
  canvasFrameListeners.add(listener);
  return () => {
    canvasFrameListeners.delete(listener);
  };
}
