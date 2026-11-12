export const CONTENTS_ACTIVATION_OFFSET = 80;

export const CONTENTS_SNAP_TOLERANCE = 1;

export interface HeadingBinding {
  readonly itemIndex: number;
  readonly node: HTMLElement;
  readonly top: number;
}

export function topInsideViewport(node: HTMLElement, viewport: HTMLElement): number {
  const viewportRect = viewport.getBoundingClientRect();
  return node.getBoundingClientRect().top - viewportRect.top + viewport.scrollTop;
}

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
