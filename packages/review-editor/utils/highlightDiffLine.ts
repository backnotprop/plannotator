const HIGHLIGHT_COLOR = 'oklch(0.82 0.12 85)';
const HIGHLIGHT_DURATION_MS = 1500;
const SETTLE_DELAY_MS = 150;

export function highlightDiffLine(line: number): void {
  requestAnimationFrame(() => {
    setTimeout(() => {
      const hosts = document.querySelectorAll('diffs-container');
      for (const host of hosts) {
        const root = host.shadowRoot;
        if (!root) continue;
        const gutterCell = root.querySelector(`[data-column-number="${line}"]`);
        if (!gutterCell) continue;
        const gutterContainer = gutterCell.parentElement;
        const codeParent = gutterContainer?.parentElement;
        if (!gutterContainer || !codeParent) continue;
        const contentContainer = codeParent.children[1];
        if (!contentContainer) continue;
        const idx = Array.from(gutterContainer.children).indexOf(gutterCell);
        const contentCell = contentContainer.children[idx] as HTMLElement | undefined;
        if (!contentCell) continue;
        gutterCell.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const cells = [gutterCell as HTMLElement, contentCell];
        for (const el of cells) {
          el.style.setProperty('--diffs-line-bg', HIGHLIGHT_COLOR, 'important');
        }
        setTimeout(() => {
          for (const el of cells) {
            el.style.removeProperty('--diffs-line-bg');
          }
        }, HIGHLIGHT_DURATION_MS);
        break;
      }
    }, SETTLE_DELAY_MS);
  });
}
