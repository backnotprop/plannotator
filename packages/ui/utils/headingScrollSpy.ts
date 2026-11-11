/** How far below the scroll element's top a heading becomes the current one. */
export const CONTENTS_ACTIVATION_OFFSET = 80;

/** How far below the activation line a heading still counts as reached. */
export const CONTENTS_SNAP_TOLERANCE = 1;

/** A heading drawn in the scroll element, with its top inside the scrolled content. */
export interface HeadingBinding {
  readonly itemIndex: number;
  readonly node: HTMLElement;
  readonly top: number;
}

export function topInsideViewport(node: HTMLElement, viewport: HTMLElement): number {
  const viewportRect = viewport.getBoundingClientRect();
  return node.getBoundingClientRect().top - viewportRect.top + viewport.scrollTop;
}

/**
 * Bind each listed heading id to its drawn heading (`[data-block-type="heading"]` with that
 * `data-block-id`), sorted by top.
 */
export function bindHeadings(
  viewport: HTMLElement,
  blockIds: readonly string[],
): HeadingBinding[] {
  const nodesByBlockId = new Map<string, HTMLElement>();
  for (const node of viewport.querySelectorAll<HTMLElement>('[data-block-type="heading"]')) {
    const id = node.dataset.blockId ?? '';
    if (!nodesByBlockId.has(id)) nodesByBlockId.set(id, node);
  }
  const bindings = blockIds.flatMap<HeadingBinding>((blockId, itemIndex) => {
    const node = nodesByBlockId.get(blockId);
    return node === undefined ? [] : [{ itemIndex, node, top: topInsideViewport(node, viewport) }];
  });
  bindings.sort((left, right) => left.top - right.top);
  return bindings;
}

/** The last binding whose top is at or above `activationTop`, else the first. */
export function currentBinding(
  bindings: readonly HeadingBinding[],
  activationTop: number,
): HeadingBinding {
  let low = 0;
  let high = bindings.length - 1;
  let result = bindings[0]!;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = bindings[middle]!;
    if (candidate.top <= activationTop) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

/**
 * The heading being read: the last one at or above the activation line (or within
 * `CONTENTS_SNAP_TOLERANCE` below it).
 */
export function activeHeadingBinding(
  bindings: readonly HeadingBinding[],
  viewport: HTMLElement,
): HeadingBinding | null {
  if (bindings.length === 0) return null;
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const atDocumentEnd = maxScrollTop > 0 && viewport.scrollTop >= maxScrollTop - 1;
  return atDocumentEnd
    ? bindings.at(-1)!
    : currentBinding(
        bindings,
        viewport.scrollTop + CONTENTS_ACTIVATION_OFFSET + CONTENTS_SNAP_TOLERANCE,
      );
}
