/**
 * Boundary trimming for web-highlighter's `Render.SelectedNodes` hook.
 *
 * Lives in its own pure module so it can be unit-tested without a DOM:
 * useAnnotationHighlighter imports @plannotator/web-highlighter, whose UMD
 * bundle reads `window` at module-eval time.
 */

/**
 * Minimal structural view of web-highlighter's `SelectedNode`: only the field
 * the trim actually reads. Declared locally rather than imported from the
 * package's `dist/`, which resolves today only because the fork ships no
 * `exports` map; a republish that adds one would break consumers compiling
 * @plannotator/ui from source.
 */
export interface SelectedNodeLike {
  $node: { textContent: string | null };
}

/**
 * Drop whitespace-only nodes from the leading and trailing ends of the node
 * list web-highlighter is about to wrap. Whitespace-only nodes in the MIDDLE of
 * a genuine multi-node selection are kept, so inter-node spacing stays
 * highlighted.
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

/**
 * Drop the empty text nodes anywhere in the list, not only at its ends. They
 * hold no text, so a highlight on them shows nothing; and they are the ones
 * web-highlighter leaves inside a highlight wrapper when it splits a text node
 * at its first or last character. A selection that runs over such a wrapper
 * takes them along with the wrapper's words, and wrapping an empty node first
 * replaces the shared wrapper with copies, so the next node in it is wrapped
 * against a parent that is no longer in the page and the library throws
 * (`Cannot read properties of null (reading 'replaceChild')`). Whitespace that
 * is really there (" ") is text, and stays.
 */
export const dropEmptyNodes = (selectedNodes: SelectedNodeLike[]): SelectedNodeLike[] =>
  selectedNodes.filter((node) => (node.$node.textContent ?? '') !== '');
