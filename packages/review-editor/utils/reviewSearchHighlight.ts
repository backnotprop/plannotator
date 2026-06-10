import type { ReviewSearchMatch } from './reviewSearch';

const PASSIVE_MATCH_BACKGROUND = '#fef08a';
const ACTIVE_MATCH_BACKGROUND = '#f59e0b';
const MATCH_FOREGROUND = '#1f2937';
const PASSIVE_MATCH_RING = '0 0 0 1px rgba(161, 98, 7, 0.18)';
const ACTIVE_MATCH_RING = '0 0 0 1px rgba(180, 83, 9, 0.35)';
const MAX_SCROLL_ATTEMPTS = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getSearchRoots(root: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [root];
  const elementRoot = root as Element;
  const walker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;

  while (current) {
    if (current instanceof HTMLElement && current.shadowRoot) {
      // The recursive call already includes the shadow root itself as its
      // first entry — pushing it here too would double every root (and
      // double all clear/apply work over its subtree).
      roots.push(...getSearchRoots(current.shadowRoot));
    }
    current = walker.nextNode() as Element | null;
  }

  return roots;
}

// Item nodes that currently contain search marks. Lets the idle path (empty
// query / no matches for the item — i.e. every scroll frame while search is
// not in use) skip the full shadow-root TreeWalker without risking stale
// marks: only nodes this module marked can need clearing.
const markedItemNodes = new WeakSet<HTMLElement>();

export function clearSearchHighlights(root: ParentNode) {
  const marks = root.querySelectorAll('mark[data-review-search-match]');
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
}

function getLineSelector(match: ReviewSearchMatch): string {
  if (match.side === 'addition') {
    return [
      `[data-line="${match.lineNumber}"][data-line-type="addition"]`,
      `[data-line="${match.lineNumber}"][data-line-type="change-addition"]`,
    ].join(', ');
  }

  if (match.side === 'deletion') {
    return [
      `[data-line="${match.lineNumber}"][data-line-type="deletion"]`,
      `[data-line="${match.lineNumber}"][data-line-type="change-deletion"]`,
    ].join(', ');
  }

  return [
    `[data-line="${match.lineNumber}"][data-line-type="context"]`,
    `[data-line="${match.lineNumber}"][data-line-type="context-expanded"]`,
  ].join(', ');
}

function decorateSearchMatch(mark: HTMLElement, isActive: boolean) {
  mark.className = 'review-search-highlight';
  mark.style.background = isActive ? ACTIVE_MATCH_BACKGROUND : PASSIVE_MATCH_BACKGROUND;
  mark.style.color = MATCH_FOREGROUND;
  mark.style.borderRadius = '3px';
  mark.style.padding = '0 1px';
  mark.style.boxShadow = isActive ? ACTIVE_MATCH_RING : PASSIVE_MATCH_RING;
  if (isActive) {
    mark.dataset.reviewSearchActive = '';
  } else {
    delete mark.dataset.reviewSearchActive;
  }
}

function lineKey(match: ReviewSearchMatch): string {
  return `${match.filePath}:${match.side}:${match.lineNumber}`;
}

export function applySearchHighlights(
  root: ParentNode,
  query: string,
  searchMatches: ReviewSearchMatch[],
  activeSearchMatchId: string | null,
) {
  clearSearchHighlights(root);
  const trimmed = query.trim();
  if (!trimmed || searchMatches.length === 0) return;

  const regex = new RegExp(escapeRegExp(trimmed), 'gi');

  // Group matches by line so we process each line element once,
  // assigning each DOM occurrence to the correct match object.
  const lineGroups = new Map<string, ReviewSearchMatch[]>();
  searchMatches.forEach((match) => {
    const key = lineKey(match);
    const group = lineGroups.get(key);
    if (group) group.push(match);
    else lineGroups.set(key, [match]);
  });

  lineGroups.forEach((matches) => {
    const lineEl = root.querySelector(getLineSelector(matches[0]));
    if (!lineEl) return;

    const textWalker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('mark[data-review-search-match]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let textNode = textWalker.nextNode() as Text | null;
    let matchIndex = 0;

    while (textNode) {
      const value = textNode.nodeValue || '';
      regex.lastIndex = 0;
      const matchesInNode = Array.from(value.matchAll(regex));

      if (matchesInNode.length === 0) {
        textNode = textWalker.nextNode() as Text | null;
        continue;
      }

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      matchesInNode.forEach((nodeMatch) => {
        const index = nodeMatch.index ?? 0;
        const len = nodeMatch[0].length;
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(value.slice(cursor, index)));
        }

        const matchObj = matches[matchIndex] ?? matches[matches.length - 1];
        const mark = document.createElement('mark');
        mark.dataset.reviewSearchMatch = matchObj.id;
        decorateSearchMatch(mark, activeSearchMatchId === matchObj.id);
        mark.textContent = value.slice(index, index + len);
        fragment.appendChild(mark);
        matchIndex += 1;
        cursor = index + len;
      });

      if (cursor < value.length) {
        fragment.appendChild(document.createTextNode(value.slice(cursor)));
      }

      const nextNode = textWalker.nextNode() as Text | null;
      textNode.parentNode?.replaceChild(fragment, textNode);
      textNode = nextNode;
    }
  });
}

/**
 * CodeView variant of {@link applySearchHighlights}.
 *
 * CodeView renders every file's diff into a single light-DOM scroll container,
 * but each visible item is its own `<diffs-container>` with its own shadow root,
 * and CodeView recycles those item elements as you scroll (element pool). A
 * one-shot `<mark>` mutation would therefore disappear when an element is reused,
 * or stick to a reused row that now shows a different file/line.
 *
 * The fix is to (re)apply marks per ITEM, hooked into CodeView's per-item render
 * cycle (`onPostRender`). `itemNode` is the item's container element handed to
 * `onPostRender`; `matchesForItem` are the search matches that belong to the
 * file this item renders (already filtered by the caller via the
 * filePath -> itemId map). We first clear any stale marks inside this item's
 * shadow root(s) (defends against recycling: the element may previously have
 * shown a different file), then apply fresh marks for this item's matches.
 *
 * Marks are inline `<mark>` wrappers with zero height delta, so they never alter
 * the measured row height (which would desync CodeView's itemMetrics).
 */
export function applyItemSearchHighlights(
  itemNode: HTMLElement,
  query: string,
  matchesForItem: ReviewSearchMatch[],
  activeSearchMatchId: string | null,
): void {
  const trimmed = query.trim();
  const idle = !trimmed || matchesForItem.length === 0;
  // Idle fast path: this runs on EVERY item render (every scroll frame) — when
  // search is not in use and this node was never marked, there is nothing to
  // clear, so skip the shadow-root walk entirely.
  if (idle && !markedItemNodes.has(itemNode)) return;

  const roots = getSearchRoots(itemNode);
  // Clear first so a node with stale marks (recycled element, query changed)
  // is reset even when this item now has no matches.
  for (const root of roots) clearSearchHighlights(root);
  markedItemNodes.delete(itemNode);
  if (idle) return;

  for (const root of roots) {
    applySearchHighlights(root, query, matchesForItem, activeSearchMatchId);
  }
  markedItemNodes.add(itemNode);
}

/** Clear all search marks inside a single CodeView item's element (used when an
 * item leaves the rendered window so a future reuse starts clean). */
export function clearItemSearchHighlights(itemNode: HTMLElement): void {
  if (!markedItemNodes.has(itemNode)) return;
  const roots = getSearchRoots(itemNode);
  for (const root of roots) clearSearchHighlights(root);
  markedItemNodes.delete(itemNode);
}

export function swapActiveSearchHighlight(
  container: HTMLElement,
  newActiveId: string | null,
): void {
  const roots = getSearchRoots(container);
  for (const root of roots) {
    const prev = root.querySelector('mark[data-review-search-active]') as HTMLElement | null;
    if (prev) {
      decorateSearchMatch(prev, false);
    }
    if (newActiveId) {
      // Match ids embed file paths — CSS.escape so a path character that is
      // special inside an attribute selector can't throw from querySelector
      // and silently abort the active-match swap.
      const next = root.querySelector(`mark[data-review-search-match="${CSS.escape(newActiveId)}"]`) as HTMLElement | null;
      if (next) {
        decorateSearchMatch(next, true);
      }
    }
  }
}

function scrollSearchTargetIntoContainer(
  scrollContainer: HTMLElement,
  target: HTMLElement,
): void {
  const containerRect = scrollContainer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  if (targetRect.height === 0 && targetRect.width === 0) return;

  const margin = Math.min(Math.max(scrollContainer.clientHeight * 0.15, 24), 96);
  const targetTop = targetRect.top - containerRect.top;
  const targetBottom = targetRect.bottom - containerRect.top;
  const isVisible =
    targetTop >= margin &&
    targetBottom <= scrollContainer.clientHeight - margin;

  if (isVisible) return;

  const centeredTop =
    scrollContainer.scrollTop +
    targetTop -
    Math.max((scrollContainer.clientHeight - targetRect.height) / 2, 0);

  scrollContainer.scrollTo({
    top: Math.max(0, centeredTop),
    behavior: 'smooth',
  });
}

export function scrollToSearchMatch(
  scrollContainer: HTMLElement,
  root: ParentNode,
  match: ReviewSearchMatch,
): boolean {
  const lineEl = root.querySelector(getLineSelector(match)) as HTMLElement | null;
  if (!lineEl) return false;

  const mark = root.querySelector(`mark[data-review-search-match="${CSS.escape(match.id)}"]`) as HTMLElement | null;
  scrollSearchTargetIntoContainer(scrollContainer, mark ?? lineEl);
  mark?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  return true;
}

export function retryScrollToSearchMatch(
  container: HTMLElement,
  match: ReviewSearchMatch,
): () => void {
  let attempts = 0;
  let cancelled = false;

  const tryScroll = () => {
    if (cancelled) return;

    const didScroll = getSearchRoots(container).some(root => scrollToSearchMatch(container, root, match));
    if (didScroll) return;

    attempts += 1;
    if (attempts < MAX_SCROLL_ATTEMPTS) {
      requestAnimationFrame(tryScroll);
    }
  };

  tryScroll();

  return () => {
    cancelled = true;
  };
}
