import { getScrollViewportRect } from '../hooks/useScrollViewport';
import { createTextRange } from './domSelection';

/**
 * Semantic document targeting shared by pointer Pinpoint and Vim navigation.
 *
 * The graph is rebuilt from the live rendered document whenever a consumer
 * needs it. Callers persist stable keys, never DOM nodes, across renders.
 */
/** Elements that never participate in document targeting. */
const SKIP_SELECTORS = [
  '.annotation-toolbar',
  '.annotation-highlight',
  'mark[data-bind-id]',
  'button',
  '[data-pinpoint-ignore]',
].join(',');

const INLINE_TARGET_SELECTOR = 'strong,em,a,code:not(.pn-code)';
const TABLE_EDGE_ZONE = 22;

/** The semantic kind of a document target. */
export type SemanticTargetKind =
  | 'group'
  | 'block'
  | 'inline'
  | 'table'
  | 'row'
  | 'cell'
  | 'code'
  | 'math';

/** A stable semantic target resolved to its current live DOM element. */
export interface SemanticTarget {
  readonly key: string;
  readonly blockId: string;
  readonly element: HTMLElement;
  readonly label: string;
  readonly kind: SemanticTargetKind;
  readonly parentKey: string | null;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
}

/**
 * One projection of the rendered document used by pointer hit-testing,
 * keyboard traversal, hierarchy refinement, overlays, and annotation actions.
 */
export interface SemanticTargetGraph {
  readonly container: HTMLElement;
  readonly targets: readonly SemanticTarget[];
  readonly byKey: ReadonlyMap<string, SemanticTarget>;
  readonly byElement: ReadonlyMap<HTMLElement, SemanticTarget>;
  /** One entry per rendered Markdown block, in document order. */
  readonly blockKeys: readonly string[];
}

/** Motions available while navigating the semantic target graph. */
export type SemanticTargetMotion =
  | 'previous-block'
  | 'next-block'
  | 'previous-sibling'
  | 'next-sibling'
  | 'parent'
  | 'child'
  | 'first-block'
  | 'last-block';

/** Pointer coordinates used for table edge-zone targeting. */
export interface SemanticPointerPosition {
  readonly clientX: number;
  readonly clientY: number;
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function inlineLabel(element: HTMLElement): string {
  const text = element.textContent?.trim() ?? '';
  const excerpt = truncate(text, 30);
  if (element.tagName === 'STRONG') return `bold: "${excerpt}"`;
  if (element.tagName === 'EM') return `italic: "${excerpt}"`;
  if (element.tagName === 'A') return `link: "${truncate(text, 25)}"`;
  return element.tagName === 'CODE' ? `code: \`${excerpt}\`` : excerpt;
}

function blockLabel(element: HTMLElement, listItem: boolean): string {
  const text = element.textContent?.trim() ?? '';
  const tag = element.tagName.toLowerCase();
  if (listItem) {
    return text ? `list item: "${truncate(text, 30)}"` : 'list item';
  }
  if (element.dataset.blockType === 'heading' || /^h[1-6]$/.test(tag)) {
    return `heading: "${truncate(text, 35)}"`;
  }
  if (tag === 'blockquote') return `blockquote: "${truncate(text, 30)}"`;
  return text ? `paragraph: "${truncate(text, 35)}"` : tag;
}

function codeBlockLabel(block: HTMLElement): string {
  const code = block.querySelector('code');
  const language = code?.className.match(/language-(\S+)/)?.[1];
  return language ? `code block (${language})` : 'code block';
}

function groupKey(group: HTMLElement): string {
  const type = group.dataset.pinpointGroup ?? 'group';
  const ids = Array.from(group.querySelectorAll<HTMLElement>('[data-block-id]'))
    .map((element) => element.dataset.blockId)
    .filter((id): id is string => Boolean(id));
  return `group:${type}:${ids[0] ?? 'empty'}:${ids.at(-1) ?? 'empty'}`;
}

function groupLabel(group: HTMLElement): string {
  if (group.dataset.pinpointGroup === 'list') return 'list';
  if (group.dataset.pinpointGroup === 'blockquote') return 'blockquote group';
  return 'group';
}

function listContentElement(block: HTMLElement): HTMLElement | null {
  if (!block.querySelector('.select-none')) return null;
  return block.children[1] instanceof HTMLElement ? block.children[1] : null;
}

function addInlineTargets(
  targets: SemanticTarget[],
  byElement: Map<HTMLElement, SemanticTarget>,
  blockId: string,
  parent: SemanticTarget,
  root: HTMLElement,
  keyPrefix: string,
): void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(INLINE_TARGET_SELECTOR))
    .filter((element) => element.textContent?.trim() && !element.closest(SKIP_SELECTORS));

  elements.forEach((element, index) => {
    const ancestorElement = element.parentElement?.closest<HTMLElement>(INLINE_TARGET_SELECTOR);
    const semanticParent = ancestorElement && root.contains(ancestorElement)
      ? byElement.get(ancestorElement) ?? parent
      : parent;
    const target: SemanticTarget = {
      key: `${keyPrefix}:inline:${index}`,
      blockId,
      element,
      label: inlineLabel(element),
      kind: 'inline',
      parentKey: semanticParent.key,
    };
    targets.push(target);
    byElement.set(element, target);
  });
}

/**
 * Build the canonical semantic target graph for a rendered Markdown document.
 *
 * Each `[data-block-id]` contributes exactly one block-navigation entry.
 * Groups, table rows/cells, and inline formatting become hierarchy nodes.
 */
export function buildSemanticTargetGraph(container: HTMLElement): SemanticTargetGraph {
  const targets: SemanticTarget[] = [];
  const byElement = new Map<HTMLElement, SemanticTarget>();
  const blockKeys: string[] = [];
  const groupTargets = new Map<HTMLElement, SemanticTarget>();

  container.querySelectorAll<HTMLElement>('[data-pinpoint-group]').forEach((group) => {
    const firstBlockId = group.querySelector<HTMLElement>('[data-block-id]')?.dataset.blockId;
    const target: SemanticTarget = {
      key: groupKey(group),
      blockId: firstBlockId ?? '',
      element: group,
      label: groupLabel(group),
      kind: 'group',
      parentKey: null,
    };
    targets.push(target);
    byElement.set(group, target);
    groupTargets.set(group, target);
  });

  for (const block of getBlockElements(container)) {
    const blockId = block.dataset.blockId;
    if (!blockId) continue;

    const group = block.closest<HTMLElement>('[data-pinpoint-group]');
    const parentKey = group ? groupTargets.get(group)?.key ?? null : null;
    const codeElement = block.querySelector<HTMLElement>('pre > code.pn-code');
    const mathElement = block.matches('.math-annotatable,[data-math-tex]')
      ? block
      : block.querySelector<HTMLElement>('.math-annotatable,[data-math-tex]');
    const table = block.querySelector<HTMLTableElement>('table');

    if (codeElement) {
      const target: SemanticTarget = {
        key: `${blockId}:code`,
        blockId,
        element: block,
        label: codeBlockLabel(block),
        kind: 'code',
        parentKey,
      };
      targets.push(target);
      byElement.set(block, target);
      blockKeys.push(target.key);
      continue;
    }

    if (mathElement) {
      const target: SemanticTarget = {
        key: `${blockId}:math`,
        blockId,
        element: mathElement,
        label: 'formula',
        kind: 'math',
        parentKey,
      };
      targets.push(target);
      byElement.set(mathElement, target);
      blockKeys.push(target.key);
      continue;
    }

    if (table) {
      const tableTarget: SemanticTarget = {
        key: `${blockId}:table`,
        blockId,
        element: block,
        label: 'table',
        kind: 'table',
        parentKey,
      };
      targets.push(tableTarget);
      byElement.set(block, tableTarget);
      blockKeys.push(tableTarget.key);

      Array.from(table.rows).forEach((row, rowIndex) => {
        const rowTarget: SemanticTarget = {
          key: `${blockId}:row:${rowIndex}`,
          blockId,
          element: row,
          label: rowIndex === 0 ? 'table header row' : `table row ${rowIndex}`,
          kind: 'row',
          parentKey: tableTarget.key,
          rowIndex,
        };
        targets.push(rowTarget);
        byElement.set(row, rowTarget);

        Array.from(row.cells).forEach((cell, columnIndex) => {
          const cellTarget: SemanticTarget = {
            key: `${blockId}:cell:${rowIndex}:${columnIndex}`,
            blockId,
            element: cell,
            label: `table cell ${rowIndex + 1}, ${columnIndex + 1}`,
            kind: 'cell',
            parentKey: rowTarget.key,
            rowIndex,
            columnIndex,
          };
          targets.push(cellTarget);
          byElement.set(cell, cellTarget);
          addInlineTargets(
            targets,
            byElement,
            blockId,
            cellTarget,
            cell,
            cellTarget.key,
          );
        });
      });
      continue;
    }

    const listContent = listContentElement(block);
    const primaryElement = listContent ?? block;
    const blockTarget: SemanticTarget = {
      key: `${blockId}:block`,
      blockId,
      element: primaryElement,
      label: blockLabel(primaryElement, listContent !== null),
      kind: 'block',
      parentKey,
    };
    targets.push(blockTarget);
    byElement.set(primaryElement, blockTarget);
    blockKeys.push(blockTarget.key);
    addInlineTargets(targets, byElement, blockId, blockTarget, primaryElement, blockId);
  }

  return {
    container,
    targets,
    byKey: new Map(targets.map((target) => [target.key, target])),
    byElement,
    blockKeys,
  };
}

/** Resolve a stable target key against a freshly built graph. */
export function resolveSemanticTarget(
  graph: SemanticTargetGraph,
  key: string | null,
): SemanticTarget | null {
  return key ? graph.byKey.get(key) ?? null : null;
}

/**
 * Create the annotation range owned by a semantic target.
 *
 * Code and math targets use their existing specialized annotation paths;
 * every text-bearing graph node resolves through this one range seam.
 */
export function createSemanticTargetRange(target: SemanticTarget): Range | null {
  return target.kind === 'code' || target.kind === 'math'
    ? null
    : createTextRange(target.element);
}

/** Return the direct semantic children of a target in document order. */
export function getSemanticTargetChildren(
  graph: SemanticTargetGraph,
  target: SemanticTarget,
): readonly SemanticTarget[] {
  return graph.targets.filter((candidate) => candidate.parentKey === target.key);
}

/** Return the block-navigation target that owns a nested semantic target. */
export function getOwningBlockTarget(
  graph: SemanticTargetGraph,
  target: SemanticTarget,
): SemanticTarget {
  let current = target;
  while (!graph.blockKeys.includes(current.key) && current.parentKey) {
    const parent = resolveSemanticTarget(graph, current.parentKey);
    if (!parent) break;
    current = parent;
  }
  if (graph.blockKeys.includes(current.key)) return current;
  return graph.blockKeys
    .map((key) => resolveSemanticTarget(graph, key))
    .find((candidate) => candidate?.blockId === target.blockId)
    ?? target;
}

/** Pick the block nearest the visible center of the document viewport. */
export function findInitialSemanticTarget(
  graph: SemanticTargetGraph,
  scrollViewport?: HTMLElement | null,
): SemanticTarget | null {
  const viewportRect = scrollViewport
    ? getScrollViewportRect(scrollViewport)
    : graph.container.getBoundingClientRect();
  const centerY = viewportRect.top + viewportRect.height / 2;
  return graph.blockKeys
    .map((key) => resolveSemanticTarget(graph, key))
    .filter((target): target is SemanticTarget => target !== null)
    .sort((left, right) => {
      const leftRect = left.element.getBoundingClientRect();
      const rightRect = right.element.getBoundingClientRect();
      return Math.abs((leftRect.top + leftRect.bottom) / 2 - centerY)
        - Math.abs((rightRect.top + rightRect.bottom) / 2 - centerY);
    })[0] ?? null;
}

/**
 * Move through block order, sibling order, or one hierarchy level.
 */
export function moveSemanticTarget(
  graph: SemanticTargetGraph,
  current: SemanticTarget,
  motion: SemanticTargetMotion,
): SemanticTarget {
  if (motion === 'parent') {
    return resolveSemanticTarget(graph, current.parentKey) ?? current;
  }
  if (motion === 'child') {
    return getSemanticTargetChildren(graph, current)[0] ?? current;
  }
  if (motion === 'first-block') {
    return resolveSemanticTarget(graph, graph.blockKeys[0] ?? null) ?? current;
  }
  if (motion === 'last-block') {
    return resolveSemanticTarget(graph, graph.blockKeys.at(-1) ?? null) ?? current;
  }
  if (motion === 'previous-sibling' || motion === 'next-sibling') {
    if (!current.parentKey) return current;
    const parent = resolveSemanticTarget(graph, current.parentKey);
    if (!parent) return current;
    const siblings = getSemanticTargetChildren(graph, parent);
    const index = siblings.findIndex((candidate) => candidate.key === current.key);
    if (index < 0) return current;
    const delta = motion === 'previous-sibling' ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(siblings.length - 1, index + delta));
    return siblings[nextIndex] ?? current;
  }

  const delta: -1 | 1 = motion === 'previous-block' ? -1 : 1;
  const block = getOwningBlockTarget(graph, current);
  const index = graph.blockKeys.indexOf(block.key);
  if (index < 0) return current;
  const nextIndex = Math.max(0, Math.min(graph.blockKeys.length - 1, index + delta));
  return resolveSemanticTarget(graph, graph.blockKeys[nextIndex] ?? null) ?? current;
}

function targetForBlock(graph: SemanticTargetGraph, block: HTMLElement): SemanticTarget | null {
  const blockId = block.dataset.blockId;
  if (!blockId) return null;
  return graph.blockKeys
    .map((key) => resolveSemanticTarget(graph, key))
    .find((target) => target?.blockId === blockId)
    ?? null;
}

function rowAtY(table: HTMLTableElement, clientY: number): HTMLTableRowElement | null {
  return Array.from(table.rows).find((row) => {
    const rect = row.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  }) ?? null;
}

/**
 * Resolve the pointer's semantic target from the same graph used by keyboard
 * navigation. Table edge zones select table/row scope; content selects cells.
 */
export function resolveSemanticTargetAtPoint(
  graph: SemanticTargetGraph,
  pointerTarget: HTMLElement,
  pointer?: SemanticPointerPosition,
): SemanticTarget | null {
  if (pointerTarget.closest(SKIP_SELECTORS)) return null;
  if (!graph.container.contains(pointerTarget)) return null;

  const group = pointerTarget.closest<HTMLElement>('[data-pinpoint-group]');
  if (group && !pointerTarget.closest('[data-block-id]')) {
    return graph.byElement.get(group) ?? null;
  }

  const block = pointerTarget.closest<HTMLElement>('[data-block-id]');
  if (!block || !graph.container.contains(block) || block.tagName === 'HR') return null;
  const blockTarget = targetForBlock(graph, block);
  if (!blockTarget) return null;

  const code = block.querySelector<HTMLElement>('pre > code.pn-code');
  if (
    code
    && (pointerTarget === code || code.contains(pointerTarget) || pointerTarget.closest('pre'))
  ) {
    return blockTarget;
  }

  const table = block.querySelector<HTMLTableElement>('table');
  if (table && pointer) {
    const rect = table.getBoundingClientRect();
    const nearHorizontalEdge = pointer.clientX - rect.left < TABLE_EDGE_ZONE
      || rect.right - pointer.clientX < TABLE_EDGE_ZONE;
    const nearVerticalEdge = pointer.clientY - rect.top < TABLE_EDGE_ZONE
      || rect.bottom - pointer.clientY < TABLE_EDGE_ZONE;
    if (nearVerticalEdge) return blockTarget;
    if (nearHorizontalEdge) {
      const row = rowAtY(table, pointer.clientY);
      return row ? graph.byElement.get(row) ?? blockTarget : blockTarget;
    }
  }

  const inline = pointerTarget.closest<HTMLElement>(INLINE_TARGET_SELECTOR);
  if (inline && block.contains(inline)) {
    const inlineTarget = graph.byElement.get(inline);
    if (inlineTarget) return inlineTarget;
  }

  const cell = pointerTarget.closest<HTMLTableCellElement>('td,th');
  if (cell && block.contains(cell)) {
    return graph.byElement.get(cell) ?? blockTarget;
  }

  return blockTarget;
}

/**
 * Backward-compatible pointer result used by existing Pinpoint consumers.
 *
 * New code should retain the semantic target itself so pointer and keyboard
 * paths share its stable key and hierarchy.
 */
export interface PinpointTarget {
  readonly element: HTMLElement;
  readonly blockId: string;
  readonly label: string;
  readonly isCodeBlock: boolean;
}

/** Resolve a pointer target through the canonical semantic graph. */
export function resolvePinpointTarget(
  target: HTMLElement,
  container: HTMLElement,
  pointer?: SemanticPointerPosition,
): PinpointTarget | null {
  const semantic = resolveSemanticTargetAtPoint(
    buildSemanticTargetGraph(container),
    target,
    pointer,
  );
  return semantic
    ? {
        element: semantic.element,
        blockId: semantic.blockId,
        label: semantic.label,
        isCodeBlock: semantic.kind === 'code',
      }
    : null;
}
