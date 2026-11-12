export const BELOW_TITLE_SLOT_ATTRIBUTE = 'data-viewer-below-title';

export const BELOW_TITLE_SLOT_MARKER = `slot-${Math.random().toString(36).slice(2, 12)}`;

const isElementIndex = (index: number): boolean => Number.isInteger(index) && index >= 0;

interface TextMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

export type MetaEdge = 'start' | 'end';

const findSlot = (root: Element): Element | null => {
  for (const child of Array.from(root.children)) {
    if (child.getAttribute(BELOW_TITLE_SLOT_ATTRIBUTE) === BELOW_TITLE_SLOT_MARKER) return child;
  }
  return null;
};

const originParent = (node: Node): HTMLElement | null => {
  let parent = node.parentElement;
  while (parent && parent.dataset?.highlightId) parent = parent.parentElement;
  return parent;
};

const isExcludedText = (node: Text): boolean =>
  node.parentElement?.closest('.annotation-exclude, .annotation-toolbar, button, .katex, .math-annotatable') != null;

const offsetIn = (parent: Element, text: Text, atEnd: boolean): number => {
  const walker = parent.ownerDocument.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === text) return offset + (atEnd ? text.length : 0);
    offset += (node as Text).length;
  }
  return offset;
};

const snapOutOfSlot = <M extends TextMeta>(root: Element, slot: Element, meta: M, edge: MetaEdge): M => {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let chosen: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.length || slot.contains(text) || isExcludedText(text)) continue;
    const before = (slot.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (edge === 'end' && before) chosen = text;
    if (edge === 'start' && !before) { chosen = text; break; }
  }
  const parent = chosen ? originParent(chosen) : null;
  if (!chosen || !parent || !root.contains(parent) || parent === root) return meta;
  const index = Array.from(root.getElementsByTagName(parent.tagName)).indexOf(parent);
  if (index < 0) return meta;
  return { ...meta, parentTagName: parent.tagName, parentIndex: index, textOffset: offsetIn(parent, chosen, edge === 'end') };
};

export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M, edge: MetaEdge): M;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined, edge: MetaEdge): M | undefined;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined, edge: MetaEdge): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex)) return meta;
  const slot = findSlot(root);
  if (!slot) return meta;
  let live = meta;
  const parent = root.getElementsByTagName(live.parentTagName)[live.parentIndex];
  if (!parent) return meta;
  if (slot.contains(parent)) {
    live = snapOutOfSlot(root, slot, live, edge);
    if (live === meta) return meta;
  }
  const list = root.getElementsByTagName(live.parentTagName);
  let skipped = 0;
  for (let i = 0; i < live.parentIndex; i++) {
    if (slot.contains(list[i]!)) skipped++;
  }
  return skipped === 0 ? live : { ...live, parentIndex: live.parentIndex - skipped };
}

export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M): M;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex)) return meta;
  const slot = findSlot(root);
  if (!slot) return meta;
  const list = root.getElementsByTagName(meta.parentTagName);
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (slot.contains(list[i]!)) continue;
    if (seen === meta.parentIndex) return i === meta.parentIndex ? meta : { ...meta, parentIndex: i };
    seen++;
  }
  return meta;
}

export function snapRangeOutOfBelowTitle(root: Element | null, range: Range): boolean {
  if (!root) return false;
  const slot = findSlot(root);
  if (!slot) return false;
  const startIn = slot.contains(range.startContainer);
  const endIn = slot.contains(range.endContainer);
  if (startIn === endIn) return false;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let chosen: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.length || slot.contains(text) || isExcludedText(text)) continue;
    const before = (slot.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (endIn && before) chosen = text;
    if (startIn && !before) { chosen = text; break; }
  }
  if (!chosen) return false;
  const next = range.cloneRange();
  if (endIn) next.setEnd(chosen, chosen.length);
  else next.setStart(chosen, 0);
  if (next.collapsed) return false;
  if (endIn) range.setEnd(chosen, chosen.length);
  else range.setStart(chosen, 0);
  return true;
}
