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
