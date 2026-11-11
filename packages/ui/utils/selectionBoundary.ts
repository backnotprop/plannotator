/** Boundary trimming for web-highlighter's `Render.SelectedNodes` hook. */

/** Minimal structural view of web-highlighter's `SelectedNode`: only the field the trim actually reads. */
export interface SelectedNodeLike {
  $node: { textContent: string | null };
}

/**
 * Drop whitespace-only nodes from the leading and trailing ends of the node list web-highlighter
 * is about to wrap.
 */
export const trimWhitespaceOnlyBoundaryNodes = (
  selectedNodes: SelectedNodeLike[],
): SelectedNodeLike[] => {
  let start = 0;
  while (start < selectedNodes.length && !/\S/.test(selectedNodes[start].$node.textContent ?? '')) {
    start += 1;
  }

  let end = selectedNodes.length;
  while (end > start && !/\S/.test(selectedNodes[end - 1].$node.textContent ?? '')) {
    end -= 1;
  }

  return selectedNodes.slice(start, end);
};

/** Drop the empty text nodes anywhere in the list, not only at its ends. */
export const dropEmptyNodes = (selectedNodes: SelectedNodeLike[]): SelectedNodeLike[] =>
  selectedNodes.filter((node) => (node.$node.textContent ?? '') !== '');
