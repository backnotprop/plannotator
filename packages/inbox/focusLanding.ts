export function focusFirst(selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) {
      el.focus(el.closest('.ib-pbody') ? { preventScroll: true } : undefined);
      return true;
    }
  }
  return false;
}

export function landFocusAfterTour(): void {
  const until = performance.now() + 3000;
  let settled = 0;
  const land = () => {
    if (performance.now() > until) return;
    if (document.querySelector('[data-tour-bar]')) {
      requestAnimationFrame(land);
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      focusFirst(['[data-settings-take-tour]', '[data-whats-new-tour] button', 'section.ib-pane h2.ib-subject', '.ib-main .ib-empty h2', '.ib-main .ib-lbody [data-thread-id]', '.ib-main h1']);
    }
    const now = document.activeElement;
    settled = now && now !== document.body && now.isConnected ? settled + 1 : 0;
    if (settled < 5) requestAnimationFrame(land);
  };
  requestAnimationFrame(land);
}
