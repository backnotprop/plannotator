import { getScrollViewportRect } from '../hooks/useScrollViewport';
import { getAnnotatableTextNodes } from './domSelection';

export interface VimTextPosition {
  readonly blockId: string;
  readonly textOffset: number;
  readonly affinity?: 'forward' | 'backward';
}

export type VimTextMotion =
  | 'left'
  | 'right'
  | 'word-forward'
  | 'word-backward'
  | 'word-end'
  | 'line-start'
  | 'line-end'
  | 'block-backward'
  | 'block-forward'
  | 'document-start'
  | 'document-end';

export interface VimBlockState {
  readonly phase: 'block';
  readonly targetKey: string;
}

export interface VimInlineState {
  readonly phase: 'inline';
  readonly targetKey: string;
}

export interface VimTextState {
  readonly phase: 'text';
  readonly targetKey: string;
  readonly cursor: VimTextPosition;
}

export interface VimVisualState {
  readonly phase: 'visual';
  readonly targetKey: string;
  readonly cursor: VimTextPosition;
  readonly anchor: VimTextPosition;
}

export interface VimVisualBlockState {
  readonly phase: 'visual-block';
  readonly targetKey: string;
  readonly anchorTargetKey: string;
}

export type VimRestorableState =
  | VimBlockState
  | VimInlineState
  | VimTextState
  | VimVisualState
  | VimVisualBlockState;

export interface VimActionState {
  readonly phase: 'action';
  readonly returnTo: VimRestorableState;
}

export type VimSelectionState =
  | { readonly phase: 'inactive' }
  | VimRestorableState
  | VimActionState;

export function createInitialVimSelectionState(): { readonly phase: 'inactive' } {
  return { phase: 'inactive' };
}

function getBlockElements(container: HTMLElement): HTMLElement[] {
  const seen = new Set<string>();
  const result: HTMLElement[] = [];

  container.querySelectorAll<HTMLElement>('[data-block-id]').forEach((element) => {
    const blockId = element.dataset.blockId;
    if (!blockId || seen.has(blockId) || element.tagName === 'HR') return;
    seen.add(blockId);
    result.push(element);
  });

  return result;
}

function getBlockText(block: HTMLElement): string {
  return getAnnotatableTextNodes(block).map((node) => node.data).join('');
}

function getPositionAtBlockBoundary(
  block: HTMLElement,
  boundary: 'start' | 'end',
): VimTextPosition | null {
  const blockId = block.dataset.blockId;
  if (!blockId) return null;
  const textLength = getBlockText(block).length;
  if (textLength === 0) return null;
  return {
    blockId,
    textOffset: boundary === 'start' ? 0 : textLength,
  };
}

function findBlock(container: HTMLElement, blockId: string): HTMLElement | null {
  for (const element of getBlockElements(container)) {
    if (element.dataset.blockId === blockId) return element;
  }
  return null;
}

function getViewportCenterY(
  container: HTMLElement,
  scrollViewport?: HTMLElement | null,
): number {
  const rect = scrollViewport
    ? getScrollViewportRect(scrollViewport)
    : container.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

export function findInitialTextPosition(
  container: HTMLElement,
  scrollViewport?: HTMLElement | null,
): VimTextPosition | null {
  const centerY = getViewportCenterY(container, scrollViewport);
  const candidates = getBlockElements(container)
    .map((block) => ({ block, position: getPositionAtBlockBoundary(block, 'start') }))
    .filter((candidate): candidate is { block: HTMLElement; position: VimTextPosition } =>
      candidate.position !== null,
    );

  candidates.sort((left, right) => {
    const leftRect = left.block.getBoundingClientRect();
    const rightRect = right.block.getBoundingClientRect();
    const leftDistance = Math.abs((leftRect.top + leftRect.bottom) / 2 - centerY);
    const rightDistance = Math.abs((rightRect.top + rightRect.bottom) / 2 - centerY);
    return leftDistance - rightDistance;
  });

  return candidates[0]?.position ?? null;
}

export function resolveTextPosition(
  container: HTMLElement,
  position: VimTextPosition,
): { node: Text; offset: number } | null {
  const block = findBlock(container, position.blockId);
  if (!block) return null;

  const nodes = getAnnotatableTextNodes(block);
  if (nodes.length === 0) return null;

  let remaining = Math.max(0, position.textOffset);
  for (const [index, node] of nodes.entries()) {
    if (remaining < node.length) {
      return { node, offset: remaining };
    }
    if (remaining === node.length) {
      if (position.affinity === 'forward' && index < nodes.length - 1) {
        remaining = 0;
        continue;
      }
      return { node, offset: remaining };
    }
    remaining -= node.length;
  }

  const lastNode = nodes[nodes.length - 1];
  return { node: lastNode, offset: lastNode.length };
}

function normalizeDomPoint(
  node: Node,
  offset: number,
): { node: Text; offset: number } | null {
  if (node instanceof Text) {
    return { node, offset: Math.max(0, Math.min(offset, node.length)) };
  }
  if (!(node instanceof Element)) return null;

  const childAtOffset = offset < node.childNodes.length
    ? node.childNodes[Math.max(0, offset)]
    : undefined;
  if (childAtOffset) {
    const nextWalker = document.createTreeWalker(childAtOffset, NodeFilter.SHOW_TEXT);
    const nextCandidate = childAtOffset instanceof Text
      ? childAtOffset
      : nextWalker.nextNode();
    const nextText = nextCandidate instanceof Text ? nextCandidate : null;
    if (nextText) return { node: nextText, offset: 0 };
  }

  const previousChild = node.childNodes[Math.max(0, offset - 1)];
  if (!previousChild) return null;
  const previousTexts = previousChild instanceof Text
    ? [previousChild]
    : previousChild instanceof Element
      ? getAnnotatableTextNodes(previousChild)
      : [];
  const previousText = previousTexts[previousTexts.length - 1];
  return previousText ? { node: previousText, offset: previousText.length } : null;
}

export function serializeTextPosition(
  container: HTMLElement,
  node: Node,
  offset: number,
): VimTextPosition | null {
  const point = normalizeDomPoint(node, offset);
  if (!point) return null;

  const block = point.node.parentElement?.closest<HTMLElement>('[data-block-id]');
  const blockId = block?.dataset.blockId;
  if (!block || !blockId || !container.contains(block)) return null;

  let textOffset = 0;
  for (const textNode of getAnnotatableTextNodes(block)) {
    if (textNode === point.node) {
      return {
        blockId,
        textOffset: textOffset + Math.max(0, Math.min(point.offset, textNode.length)),
      };
    }
    textOffset += textNode.length;
  }
  return null;
}

function compareTextPositions(
  container: HTMLElement,
  left: VimTextPosition,
  right: VimTextPosition,
): number {
  if (left.blockId === right.blockId) return left.textOffset - right.textOffset;
  const blocks = getBlockElements(container);
  const leftIndex = blocks.findIndex((block) => block.dataset.blockId === left.blockId);
  const rightIndex = blocks.findIndex((block) => block.dataset.blockId === right.blockId);
  return leftIndex - rightIndex;
}

export function createRangeBetweenTextPositions(
  container: HTMLElement,
  anchor: VimTextPosition,
  cursor: VimTextPosition,
): Range | null {
  const anchorPoint = resolveTextPosition(container, anchor);
  const cursorPoint = resolveTextPosition(container, cursor);
  if (!anchorPoint || !cursorPoint) return null;

  const anchorFirst = compareTextPositions(container, anchor, cursor) <= 0;
  const start = anchorFirst ? anchorPoint : cursorPoint;
  const end = anchorFirst ? cursorPoint : anchorPoint;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

export function getTextElementBounds(
  container: HTMLElement,
  element: HTMLElement,
): { start: VimTextPosition; end: VimTextPosition } | null {
  const nodes = getAnnotatableTextNodes(element);
  const first = nodes[0];
  const last = nodes.at(-1);
  if (!first || !last) return null;
  const start = serializeTextPosition(container, first, 0);
  const end = serializeTextPosition(container, last, last.length);
  return start && end
    ? {
        start: { ...start, affinity: 'forward' },
        end: { ...end, affinity: 'backward' },
      }
    : null;
}

export function applyNativeTextSelection(
  container: HTMLElement,
  cursor: VimTextPosition,
  anchor: VimTextPosition | null,
): Selection | null {
  const cursorPoint = resolveTextPosition(container, cursor);
  if (!cursorPoint) return null;

  const selection = window.getSelection();
  selection?.removeAllRanges();
  if (!selection) return null;

  if (!anchor) {
    const range = document.createRange();
    range.setStart(cursorPoint.node, cursorPoint.offset);
    range.collapse(true);
    selection.addRange(range);
    return selection;
  }

  const anchorPoint = resolveTextPosition(container, anchor);
  if (!anchorPoint) return null;
  selection.setBaseAndExtent(
    anchorPoint.node,
    anchorPoint.offset,
    cursorPoint.node,
    cursorPoint.offset,
  );
  return selection;
}

function segmentBoundaries(text: string, granularity: 'grapheme' | 'word'): number[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity });
  return Array.from(segmenter.segment(text), (segment) => segment.index);
}

function moveWithinBlock(
  text: string,
  offset: number,
  motion: VimTextMotion,
): number | null {
  const safeOffset = Math.max(0, Math.min(offset, text.length));

  if (motion === 'left' || motion === 'right') {
    const boundaries = [...segmentBoundaries(text, 'grapheme'), text.length];
    if (motion === 'left') {
      return boundaries.filter((boundary) => boundary < safeOffset).at(-1) ?? null;
    }
    return boundaries.find((boundary) => boundary > safeOffset) ?? null;
  }

  if (
    motion === 'word-forward'
    || motion === 'word-backward'
    || motion === 'word-end'
  ) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    const words = Array.from(segmenter.segment(text)).filter((segment) => segment.isWordLike);
    if (motion === 'word-backward') {
      return words.filter((word) => word.index < safeOffset).at(-1)?.index ?? null;
    }
    if (motion === 'word-end') {
      const word = words.find((candidate) => candidate.index + candidate.segment.length > safeOffset);
      return word ? word.index + word.segment.length : null;
    }
    return words.find((word) => word.index > safeOffset)?.index ?? null;
  }

  if (motion === 'line-start') return 0;
  if (motion === 'line-end') return text.length;
  return null;
}

export function moveTextPosition(
  container: HTMLElement,
  position: VimTextPosition,
  motion: VimTextMotion,
  scrollViewport?: HTMLElement | null,
): VimTextPosition {
  const currentBlock = findBlock(container, position.blockId);
  if (!currentBlock) return findInitialTextPosition(container, scrollViewport) ?? position;
  const currentText = getBlockText(currentBlock);
  const nextOffset = moveWithinBlock(currentText, position.textOffset, motion);
  if (nextOffset !== null) {
    return { blockId: position.blockId, textOffset: nextOffset };
  }

  const blocks = getBlockElements(container).filter((block) => getBlockText(block).length > 0);
  if (blocks.length === 0) return position;
  if (motion === 'document-start') {
    return getPositionAtBlockBoundary(blocks[0], 'start') ?? position;
  }
  if (motion === 'document-end') {
    return getPositionAtBlockBoundary(blocks[blocks.length - 1], 'end') ?? position;
  }

  const blockIndex = blocks.indexOf(currentBlock);
  if (blockIndex < 0) return findInitialTextPosition(container, scrollViewport) ?? position;
  if (motion === 'block-backward' || motion === 'block-forward') {
    const delta = motion === 'block-backward' ? -1 : 1;
    const nextBlock = blocks[Math.max(0, Math.min(blocks.length - 1, blockIndex + delta))];
    return getPositionAtBlockBoundary(nextBlock, 'start') ?? position;
  }

  const direction = motion === 'left' || motion === 'word-backward' ? -1 : 1;
  const adjacent = blocks[blockIndex + direction];
  if (!adjacent) return position;
  return getPositionAtBlockBoundary(adjacent, direction < 0 ? 'end' : 'start') ?? position;
}
