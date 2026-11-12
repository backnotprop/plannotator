const WAIT_MS = 15_000;
const HOLD_MS = 2_000;

export function focusBoardTitle(id: string, onFocused?: (title: string) => void): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  const selector = `[data-shape-layer="${CSS.escape(id)}"]:not([hidden]) h1`;
  const before = onFocused ? document.querySelector('[data-shape-layer] h1') : null;
  const focusOn = (title: HTMLElement) => {
    if (!title.hasAttribute('tabindex')) title.tabIndex = -1;
    title.focus({ preventScroll: true });
  };
  const take = (): boolean => {
    const title = document.querySelector<HTMLElement>(selector);
    if (!title || title === before) return false;
    focusOn(title);
    onFocused?.(title.textContent?.trim() ?? '');
    return true;
  };
  const hold = () => {
    if (!onFocused) return;
    const until = Date.now() + HOLD_MS;
    const check = () => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        const title = document.querySelector<HTMLElement>(selector);
        if (title) focusOn(title);
      } else if (!active.matches(selector)) return;
      if (Date.now() < until) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };
  requestAnimationFrame(() => {
    if (take()) return hold();
    const observer = new MutationObserver(() => {
      if (take()) {
        done();
        hold();
      }
    });
    const timer = setTimeout(() => done(), WAIT_MS);
    function done() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
