import { normalizeFontFamilyName, quoteFontFamily } from './cssFontFamily';

export const DOCUMENT_FONT_PRESETS = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  'sans-serif': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  monospace: 'var(--font-mono), ui-monospace, monospace',
} as const;

export const DOCUMENT_FONT_OPTIONS = [
  { value: '', label: 'Theme Default' },
  { value: 'serif', label: 'Serif' },
  { value: 'sans-serif', label: 'Sans Serif' },
  { value: 'monospace', label: 'Monospace' },
] as const;

export const DOCUMENT_FONT_ATTRIBUTE = 'data-doc-font';

export const DOCUMENT_FONT_PROPERTY = '--doc-font-family';

export function documentFontStack(value: string | undefined): string {
  const name = value ? normalizeFontFamilyName(value) : '';
  if (!name) return '';
  if (Object.hasOwn(DOCUMENT_FONT_PRESETS, name)) {
    return DOCUMENT_FONT_PRESETS[name as keyof typeof DOCUMENT_FONT_PRESETS];
  }
  return `${quoteFontFamily(name)}, var(--font-sans), sans-serif`;
}

export function applyDocumentFont(root: HTMLElement, value: string | undefined): void {
  const stack = documentFontStack(value);
  if (!stack) {
    root.removeAttribute(DOCUMENT_FONT_ATTRIBUTE);
    root.style.removeProperty(DOCUMENT_FONT_PROPERTY);
    return;
  }
  root.setAttribute(DOCUMENT_FONT_ATTRIBUTE, '');
  root.style.setProperty(DOCUMENT_FONT_PROPERTY, stack);
}
