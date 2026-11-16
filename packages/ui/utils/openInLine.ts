import type { Annotation, Block } from '../types';

/**
 * The source line of a point inside a rendered block: the block's own first
 * line, or for a code fence or a whole-file code document, the line the point
 * is on (counted from the newlines before it in the block's text).
 */
function lineInBlock(blockEl: Element, block: Block, node: Node, offset: number): number {
  const counted = block.contentStartLine !== undefined
    ? block.contentStartLine
    : block.type === 'code'
      ? block.startLine + 1 // the opening fence sits on startLine
      : null;
  if (counted === null) return block.startLine;
  const doc = blockEl.ownerDocument;
  if (!doc) return counted;
  // The code's own text (CodeBlock draws it in one <code>, nothing before it).
  const text = blockEl.querySelector('code') ?? blockEl;
  if (!text.contains(node)) return counted;
  const range = doc.createRange();
  try {
    range.setStart(text, 0);
    range.setEnd(node, offset);
  } catch {
    return counted;
  }
  const before = range.toString();
  let newlines = 0;
  for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) newlines++;
  return counted + newlines;
}

function lineAt(container: HTMLElement, blocks: readonly Block[], node: Node, offset: number): number | undefined {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const blockEl = el?.closest('[data-block-id]');
  if (!blockEl || !container.contains(blockEl)) return undefined;
  const block = blocks.find((b) => b.id === blockEl.getAttribute('data-block-id'));
  return block ? lineInBlock(blockEl, block, node, offset) : undefined;
}

/**
 * The line of the document's file that plan review's and annotate's "Open in"
 * opens at, read at the click:
 *  - the picked comment: its diagram part's or image's own source line, else
 *    the line of its highlight in the page, else its block's first line;
 *  - else text selected in the document: the line it starts on;
 *  - else none (the file opens at its top).
 * Only meaningful when the blocks are the file's own (not a plan diff view).
 */
export function documentOpenInLine(
  container: HTMLElement | null,
  blocks: readonly Block[],
  annotations: readonly Annotation[],
  selectedAnnotationId: string | null,
  selection: Selection | null,
): number | undefined {
  if (!container) return undefined;
  const ann = selectedAnnotationId ? annotations.find((a) => a.id === selectedAnnotationId) : undefined;
  if (ann) {
    const own = ann.diagramAnchor?.sourceLine?.[0] ?? ann.imageRegion?.sourceLine ?? null;
    if (typeof own === 'number' && own > 0) return own;
    const mark = container.querySelector(`[data-bind-id="${CSS.escape(ann.id)}"], [data-highlight-id="${CSS.escape(ann.id)}"]`);
    if (mark) {
      const line = lineAt(container, blocks, mark, 0);
      if (line) return line;
    }
    const block = ann.blockId ? blocks.find((b) => b.id === ann.blockId) : undefined;
    if (block) return block.startLine;
  }
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (container.contains(range.startContainer)) {
      return lineAt(container, blocks, range.startContainer, range.startOffset);
    }
  }
  return undefined;
}
