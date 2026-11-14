/**
 * The focus after a Show me from a board. The Annotate box it was pressed in closes, and the focus goes back to the
 * board's title, not to the page. When the new board opens, its title takes the focus and is said. The title is the
 * board's own `h1`: it takes the focus without joining the Tab order.
 */

/** How long a new board may take to arrive before nothing waits for it any more. */
const WAIT_MS = 15_000;
/** How long after a new board's title takes the focus it gets it back if the focus falls to the page. */
const HOLD_MS = 2_000;

/**
 * Focus the title of board `id` once it shows, then call `onFocused` with the title's words. With `onFocused` (a
 * board that is opening), a title already on screen when this is called belongs to the board before it, and is not
 * taken.
 */
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
  // A board that opens draws again as it settles (its layer, its first read): a focus that fell to the page meanwhile
  // goes back to the title. A focus the person moved somewhere stays there.
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
  // After the box that was pressed has closed and the board has rendered.
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
