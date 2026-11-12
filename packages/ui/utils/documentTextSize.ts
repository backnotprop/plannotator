export const DOCUMENT_TEXT_SIZE_OPTIONS = [13, 15, 17, 19, 21] as const;

export type DocumentTextSize = (typeof DOCUMENT_TEXT_SIZE_OPTIONS)[number];

export const DEFAULT_DOCUMENT_TEXT_SIZE: DocumentTextSize = 15;

export const DOCUMENT_TEXT_SIZE_ATTRIBUTE = 'data-doc-text-size';

export const DOCUMENT_TEXT_SCALE_PROPERTY = '--doc-text-scale';

export function isDocumentTextSize(value: unknown): value is DocumentTextSize {
  return (DOCUMENT_TEXT_SIZE_OPTIONS as readonly unknown[]).includes(value);
}

export function documentTextScale(size: DocumentTextSize): number {
  return size / DEFAULT_DOCUMENT_TEXT_SIZE;
}

export function applyDocumentTextSize(root: HTMLElement, size: number): void {
  if (!isDocumentTextSize(size) || size === DEFAULT_DOCUMENT_TEXT_SIZE) {
    root.removeAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE);
    root.style.removeProperty(DOCUMENT_TEXT_SCALE_PROPERTY);
    return;
  }
  root.setAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE, String(size));
  root.style.setProperty(DOCUMENT_TEXT_SCALE_PROPERTY, String(documentTextScale(size)));
}
