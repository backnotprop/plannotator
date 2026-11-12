/**
 * A text selection kept across a highlight painted under it.
 *
 * Painting a highlight splits text nodes and moves them into marks; removing
 * one moves them back out. By the DOM's rules a selection end inside a node
 * that is moved jumps to the node's parent, so the live selection a finger is
 * still adjusting ends up somewhere else (or collapses), and iOS drops its
 * handles. Counted in characters of text from the start of a root, a position
 * does not change when the text is only re-wrapped, so a selection read as
 * character offsets before the paint is put back over the same characters
 * after it.
 */

export interface SavedSelectionEnd {
  /** Characters of text before this end, counted from the start of the root; null when the end is outside the root. */
  offset: number | null;
  /** The end as it was, for an end outside the root (a re-wrap inside the root never moves it). */
  node: Node;
  nodeOffset: number;
}

export interface SavedSelection {
  anchor: SavedSelectionEnd;
  focus: SavedSelectionEnd;
}

/** Characters of text in `root` before (node, offset); null when the point is outside `root`. */
export function textOffsetIn(root: Node, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  const doc = root.ownerDocument ?? (root as Document);
  const before = doc.createRange();
  try {
    before.setStart(root, 0);
    before.setEnd(node, offset);
  } catch {
    return null;
  }
  return before.toString().length;
}

/**
 * The (text node, offset) at `offset` characters into `root`. Between two text
 * nodes, a selection's START goes to the beginning of the later one (`forward`)
 * and its END to the close of the earlier one (`backward`): both then sit
 * inside the marks that cover the selected words.
 */
export function textPointAt(root: Node, offset: number, bias: 'forward' | 'backward'): [Text, number] | null {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    if (length === 0) continue;
    if (bias === 'forward' ? offset < total + length : offset <= total + length) {
      return [text, Math.max(0, offset - total)];
    }
    total += length;
    last = text;
  }
  // Past the last character: the end of the last text.
  return last && offset === total ? [last, last.data.length] : null;
}

/** The live selection's two ends, read so they survive a re-wrap inside `root`. */
export function saveSelection(root: Node, selection: Selection): SavedSelection | null {
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || selection.rangeCount === 0) return null;
  const end = (node: Node, nodeOffset: number): SavedSelectionEnd => ({ offset: textOffsetIn(root, node, nodeOffset), node, nodeOffset });
  return { anchor: end(anchorNode, selection.anchorOffset), focus: end(focusNode, selection.focusOffset) };
}

/**
 * Puts a saved selection back over the same characters, its direction (which
 * end the finger moves) kept. False when it cannot be put back (its text is
 * gone), and the selection is then left as it is.
 */
export function restoreSelection(root: Node, selection: Selection, saved: SavedSelection): boolean {
  const { anchor, focus } = saved;
  // Which end is the start decides which side of a node boundary each end takes.
  const before = (outside: Node) => (root.compareDocumentPosition(outside) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  const inOrder = anchor.offset !== null && focus.offset !== null
    ? anchor.offset <= focus.offset
    : anchor.offset === null && focus.offset === null
      ? true // both ends outside: put back as they were, either way
      : anchor.offset === null ? before(anchor.node) : !before(focus.node);
  const place = (end: SavedSelectionEnd, isStart: boolean): [Node, number] | null => {
    if (end.offset === null) return end.node.isConnected ? [end.node, end.nodeOffset] : null;
    return textPointAt(root, end.offset, isStart ? 'forward' : 'backward');
  };
  const a = place(anchor, inOrder);
  const f = place(focus, !inOrder);
  if (!a || !f) return false;
  try {
    selection.setBaseAndExtent(a[0], a[1], f[0], f[1]);
  } catch {
    return false;
  }
  return true;
}

/** Whether the live selection covers the same characters as a saved one (its ends, in either direction). */
export function sameSelection(root: Node, selection: Selection, saved: SavedSelection): boolean {
  const now = saveSelection(root, selection);
  if (!now) return false;
  const same = (x: SavedSelectionEnd, y: SavedSelectionEnd) => x.offset !== null && y.offset !== null
    ? x.offset === y.offset
    : x.offset === y.offset && x.node === y.node && x.nodeOffset === y.nodeOffset;
  return (same(now.anchor, saved.anchor) && same(now.focus, saved.focus))
    || (same(now.anchor, saved.focus) && same(now.focus, saved.anchor));
}
