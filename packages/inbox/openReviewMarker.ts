export const OPEN_REVIEW_MARKER = 'open-review';

function takeOpenMarker(): string | null {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(window.location.search);
  const thread = search.get(OPEN_REVIEW_MARKER);
  if (!thread) return null;
  search.delete(OPEN_REVIEW_MARKER);
  const rest = search.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  return thread;
}

let asked = takeOpenMarker();

export function takeAskedReview(threadId: string): boolean {
  if (asked !== threadId) return false;
  asked = null;
  return true;
}
