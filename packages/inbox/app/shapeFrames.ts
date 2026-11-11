/** Who hears the event stream's `event: shapes` (the window has one stream; useInboxShapes listens here). */
export const shapeFrameListeners = new Set<(ids: string[]) => void>();
export const subscribeShapeFrames = (listener: (ids: string[]) => void) => {
  shapeFrameListeners.add(listener);
  return () => {
    shapeFrameListeners.delete(listener);
  };
};
