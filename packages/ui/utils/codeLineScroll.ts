/**
 * Find a rendered code line in a file area drawn by Pierre's `File`, and wait
 * for it when it is not there yet. Pierre draws the lines inside the shadow
 * root of a `diffs-container` it attaches in the element's constructor, and
 * may draw them some time after mount (a worker highlight, a large file), so a
 * fixed delay can fire before the line exists.
 */

function lineSelector(line: number): string {
  return `[data-line="${line}"]`;
}

/** The element of code line `line` under `root`, in its own DOM or a Pierre shadow root. */
export function findCodeLineElement(root: ParentNode, line: number): HTMLElement | null {
  const selector = lineSelector(line);
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct) return direct;
  for (const container of root.querySelectorAll('diffs-container')) {
    const inShadow = container.shadowRoot?.querySelector<HTMLElement>(selector);
    if (inShadow) return inShadow;
  }
  return null;
}

/** How long to wait for a line before giving up (a file that never draws it). */
export const CODE_LINE_WAIT_MS = 5_000;

/**
 * Call `onFound` once with code line `line` under `root`, in the frame after it
 * exists (so it has been laid out). Watches `root` and every Pierre shadow root
 * that appears under it until the line shows up. Gives up at once when the line
 * cannot exist (below 1, or past `lineCount`), and after `timeoutMs`. Returns a
 * function that stops watching; call it on unmount or when the line or file
 * changes.
 */
export function whenCodeLineRendered(
  root: HTMLElement,
  line: number,
  onFound: (element: HTMLElement) => void,
  options: { lineCount?: number; timeoutMs?: number } = {},
): () => void {
  if (!Number.isInteger(line) || line < 1 || (options.lineCount != null && line > options.lineCount)) {
    return () => {};
  }
  let stopped = false;
  let frame: number | null = null;
  const observers: MutationObserver[] = [];
  const watched = new Set<Node>();

  const stopWatching = () => {
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    watched.clear();
  };

  const watch = (node: Node) => {
    if (watched.has(node)) return;
    watched.add(node);
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true });
    observers.push(observer);
  };

  function check() {
    if (stopped || frame != null) return;
    if (findCodeLineElement(root, line)) {
      stopWatching();
      frame = requestAnimationFrame(() => {
        frame = null;
        if (stopped) return;
        // Look it up again: a highlight pass may have replaced the element.
        const element = findCodeLineElement(root, line);
        if (element) {
          stop();
          onFound(element);
          return;
        }
        watch(root);
        check();
      });
      return;
    }
    for (const container of root.querySelectorAll('diffs-container')) {
      if (container.shadowRoot) watch(container.shadowRoot);
    }
  }

  const stop = () => {
    stopped = true;
    stopWatching();
    clearTimeout(giveUp);
    if (frame != null) cancelAnimationFrame(frame);
  };
  const giveUp = setTimeout(stop, options.timeoutMs ?? CODE_LINE_WAIT_MS);

  watch(root);
  check();

  return stop;
}

/** The element's parent, or its shadow root's host (Pierre draws lines in a shadow root). */
function parentAcross(node: Element): HTMLElement | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}

/**
 * Bring a code line to the middle of the view, vertically only. `scrollIntoView` alone also slides a line wider than
 * the view sideways (by the gutter's width), even in a short file with nothing to scroll down. The nearest ancestor
 * that scrolls vertically (across Pierre's shadow root) moves; with none, `scrollIntoView` brings the line on screen
 * (the page may move) and every ancestor's sideways position is put back as it was.
 */
export function scrollCodeLineIntoView(row: HTMLElement, options: { smooth?: boolean } = {}): void {
  const sideways: [HTMLElement, number][] = [];
  for (let node = parentAcross(row); node; node = parentAcross(node)) {
    if (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      const box = node.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const top = node.scrollTop + rect.top - (box.top + box.height / 2) + rect.height / 2;
      if (options.smooth && typeof node.scrollTo === 'function') node.scrollTo({ top, behavior: 'smooth' });
      else node.scrollTop = top;
      return;
    }
    sideways.push([node, node.scrollLeft]);
  }
  row.scrollIntoView({ block: 'center', inline: 'nearest' });
  for (const [node, left] of sideways) if (node.scrollLeft !== left) node.scrollLeft = left;
}
