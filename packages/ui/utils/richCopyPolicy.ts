/**
 * Default: false, so a host that does not opt in (Workspaces) keeps the toolbar and its
 * plain-text Copy exactly as before.
 */
let richCopy = false;

export function setRichCopyEnabled(on: boolean): void {
  richCopy = on;
}

export function resetRichCopyEnabled(): void {
  richCopy = false;
}

export function getRichCopyEnabled(): boolean {
  return richCopy;
}
