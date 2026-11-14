const MAX_FRAMES = 12;

function headerStop(path: string): HTMLElement | null {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[data-file-header-path]')).filter((header) => header.dataset.fileHeaderPath === path);
  const header = matches.find((el) => el.getClientRects().length > 0) ?? matches[0];
  if (!header) return null;
  return header.querySelector<HTMLElement>('[tabindex="0"]') ?? header;
}

export function focusLost(path?: string): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) return true;
  const header = path ? active.closest<HTMLElement>('[data-file-header-path]') : null;
  return !!header && header.dataset.fileHeaderPath !== path;
}

export function focusFileHeaderWhenLost(path: string | null | undefined, frames = MAX_FRAMES): void {
  if (!path || typeof window === 'undefined') return;
  const attempt = (left: number) => {
    if (!focusLost(path)) return;
    const stop = headerStop(path);
    if (stop) {
      stop.focus({ preventScroll: true });
      return;
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  requestAnimationFrame(() => attempt(frames));
}

export function focusReviewPanelSoon(tab: string, frames = MAX_FRAMES): void {
  const attempt = (left: number) => {
    const target = document.getElementById(`review-sidebar-tab-${tab}`);
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  requestAnimationFrame(() => attempt(frames));
}
