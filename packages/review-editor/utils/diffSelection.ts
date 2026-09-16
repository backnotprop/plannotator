export function getLineNumberFromNode(node: Node | null): number | null {
  let current: Node | null = node;
  if (current?.nodeType === Node.TEXT_NODE) current = current.parentNode;
  while (current) {
    if (current instanceof HTMLElement) {
      const line = current.closest('[data-line]')?.getAttribute('data-line');
      if (line) {
        const parsed = Number(line);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }
    current = current.parentNode;
  }
  return null;
}

export function getSideFromNode(node: Node | null): 'additions' | 'deletions' {
  let current: Node | null = node;
  if (current?.nodeType === Node.TEXT_NODE) current = current.parentNode;
  while (current) {
    if (current instanceof HTMLElement) {
      if (current.hasAttribute('data-deletions')) return 'deletions';
      if (current.hasAttribute('data-additions')) return 'additions';
    }
    current = current.parentNode;
  }
  return 'additions';
}

export function getDiffSelection(root: HTMLElement | null): Selection | null {
  if (!root) return window.getSelection();
  const containers = root.querySelectorAll('diffs-container');
  for (const container of containers) {
    const sr = container.shadowRoot;
    if (!sr) continue;
    const sel = (sr as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
    if (sel && !sel.isCollapsed) return sel;
  }
  return window.getSelection();
}

export interface DiffSelectionSnapshot {
  start: number;
  end: number;
  side: 'deletions' | 'additions';
  host?: HTMLElement | null;
}

export function snapshotDiffSelection(
  root: HTMLElement | null,
  customSelection?: Selection | null,
): DiffSelectionSnapshot | null {
  const selection = customSelection ?? getDiffSelection(root);
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
  const anchorLine = getLineNumberFromNode(selection.anchorNode);
  const focusLine = getLineNumberFromNode(selection.focusNode);
  if (anchorLine == null || focusLine == null) return null;
  const side = getSideFromNode(selection.anchorNode);
  const rootNode = selection.anchorNode?.getRootNode();
  const host = rootNode instanceof ShadowRoot && rootNode.host instanceof HTMLElement ? rootNode.host : null;
  return {
    start: Math.min(anchorLine, focusLine),
    end: Math.max(anchorLine, focusLine),
    side,
    host,
  };
}
