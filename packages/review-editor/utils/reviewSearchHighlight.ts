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
      roots.push(current.shadowRoot);
      roots.push(...getSearchRoots(current.shadowRoot));
    }
    current = walker.nextNode() as Element | null;
  }

  return roots;
}

function clearSearchHighlights(root: ParentNode) {
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
}

export function applySearchHighlights(
  root: ParentNode,
  query: string,
  searchMatches: ReviewSearchMatch[],
  activeSearchMatchId: string | null,
) {
  clearSearchHighlights(root);
  if (!query.trim() || searchMatches.length === 0) return;

  const regex = new RegExp(escapeRegExp(query), 'gi');

  searchMatches.forEach((match) => {
    const lineEl = root.querySelector(getLineSelector(match));
    if (!lineEl) return;

    const textWalker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('mark[data-review-search-match]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let textNode = textWalker.nextNode() as Text | null;
    let activeMarkApplied = false;

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
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(value.slice(cursor, index)));
        }

        const mark = document.createElement('mark');
        mark.dataset.reviewSearchMatch = match.id;
        const isActive = !activeMarkApplied && activeSearchMatchId === match.id;
        decorateSearchMatch(mark, isActive);
        mark.textContent = value.slice(index, index + query.length);
        fragment.appendChild(mark);
        activeMarkApplied = activeMarkApplied || isActive;
        cursor = index + query.length;
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

export function scrollToSearchMatch(root: ParentNode, match: ReviewSearchMatch): boolean {
  const lineEl = root.querySelector(getLineSelector(match)) as HTMLElement | null;
  if (!lineEl) return false;

  lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const mark = root.querySelector(`mark[data-review-search-match="${match.id}"]`) as HTMLElement | null;
  mark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    const didScroll = getSearchRoots(container).some(root => scrollToSearchMatch(root, match));
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
