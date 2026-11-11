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
      }
    }
    try {
      opener.open(url, '_blank', 'noopener,noreferrer');
    } catch {
    }
  });
}

export function closePendingTab(tab: PendingTabWindow | null): void {
  if (!tab || tab.closed) return;
  try {
    tab.close();
  } catch {
  }
}
