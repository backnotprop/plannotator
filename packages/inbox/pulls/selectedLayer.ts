/**
 * Which layer's row Reviews' list shows selected beside an open stack (PullsPage → ReviewsList `selectedLayer`). It is
 * read from the address each time, never remembered: the layer whose diff closed back to the stack (`Route.backLayer`,
 * `layerClosed`), the top layer included though its key is the stack's id; else a stack opened by a lower layer's own
 * key. A stack opened by its id, or any list beside a thread, shows the stack's own row.
 */
export function selectedLayerOf(openStackId: string | null, address: { threadId?: string | null; stackId: string | null; layerId?: string | null }): string | null {
  if (address.threadId || openStackId === null) return null;
  if (address.layerId) return address.layerId;
  return address.stackId && address.stackId !== openStackId ? address.stackId : null;
}
