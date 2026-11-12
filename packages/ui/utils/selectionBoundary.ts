export interface SelectedNodeLike {
  $node: { textContent: string | null };
}

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

export const dropEmptyNodes = (selectedNodes: SelectedNodeLike[]): SelectedNodeLike[] =>
  selectedNodes.filter((node) => (node.$node.textContent ?? '') !== '');
