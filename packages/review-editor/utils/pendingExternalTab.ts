/**
 * "View on <platform> after submitting" (#1583).
 *
 * Browsers only let a page open a tab while it holds transient user
 * activation, which expires a few seconds after the click (and an `await`
 * chain over a large review easily outlives it). So the tab is opened
 * SYNCHRONOUSLY inside the submit gesture, shows a short placeholder, and is
 * navigated to the PR once the platform confirms the review — or closed when
 * the submission does not complete.
 *
 * When no tab could be opened (popup blocked, or an embedding such as the VS
 * Code webview that forbids popups) the caller falls back to `window.open`
 * after success, and the completion screen always offers clickable links.
 */

/** The slice of `Window` this module touches; injectable for tests. */
export interface TabOpener {
  open(url?: string, target?: string, features?: string): PendingTabWindow | null;
}

export interface PendingTabWindow {
  closed: boolean;
  opener: unknown;
  location: { href: string };
  document?: { title: string; body: { textContent: string | null } | null } | null;
  close(): void;
}

/**
 * Open the placeholder tab. Call this synchronously from the click / keydown
 * handler that submits the review. Returns null when the browser refused.
 */
export function openPendingTab(
  opener: TabOpener,
  platformLabel: string,
): PendingTabWindow | null {
  let tab: PendingTabWindow | null = null;
  try {
    tab = opener.open('', '_blank');
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    // The PR page must not be able to reach back into this one.
    tab.opener = null;
    if (tab.document) {
      tab.document.title = `Posting review to ${platformLabel}…`;
      if (tab.document.body) {
        tab.document.body.textContent = `Posting your review to ${platformLabel}…`;
      }
    }
  } catch {
    // A placeholder that cannot be decorated still navigates fine.
  }
  return tab;
}

/**
 * Settle the placeholder after a successful submission: the first URL goes to
 * the placeholder; any other URL (or the first, when there is no placeholder)
 * is opened directly, which is a no-op where popups are blocked — the
 * completion screen's links cover that. With no URL the placeholder closes.
 */
export function settlePendingTab(
  tab: PendingTabWindow | null,
  urls: readonly string[],
  opener: TabOpener,
): void {
  if (urls.length === 0) {
    closePendingTab(tab);
    return;
  }
  urls.forEach((url, index) => {
    if (index === 0 && tab && !tab.closed) {
      try {
        tab.location.href = url;
        return;
      } catch {
        // Fall through to a direct open.
      }
    }
    try {
      opener.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // Blocked: the completion screen links remain.
    }
  });
}

/** Close a placeholder tab the submission will not use. */
export function closePendingTab(tab: PendingTabWindow | null): void {
  if (!tab || tab.closed) return;
  try {
    tab.close();
  } catch {
    // Already gone.
  }
}
