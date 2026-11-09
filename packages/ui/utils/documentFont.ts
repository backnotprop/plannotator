/**
 * The document's font in plan review and annotate (Settings → Display →
 * Document font, #1657): the family the document's text is drawn in. Empty by
 * default, which keeps the theme's font (the document as it has always been
 * drawn).
 *
 * The value is one of the generic presets below or the family name of a font
 * installed on the machine, as for the code font (#851). A name always goes
 * through `quoteFontFamily`, and the theme's sans font follows it, so a name
 * that is not installed falls back to today's look.
 *
 * The app puts it on the document element (`applyDocumentFont`, through
 * `hooks/useDocumentFont`) and packages/ui/theme.css hands it to the blocks of
 * a document container (`data-doc-text-root`), the same scope as Text size.
 * Code (inline code, code blocks, the raw diff) keeps the monospace font, and
 * diagrams and the table / diagram popouts are left out.
 */

import { normalizeFontFamilyName, quoteFontFamily } from './cssFontFamily';

/** Generic stacks Settings offers by name. Every one always resolves. */
export const DOCUMENT_FONT_PRESETS = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  'sans-serif': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  monospace: 'var(--font-mono), ui-monospace, monospace',
} as const;

/** The options of the Settings select, Theme Default first. */
export const DOCUMENT_FONT_OPTIONS = [
  { value: '', label: 'Theme Default' },
  { value: 'serif', label: 'Serif' },
  { value: 'sans-serif', label: 'Sans Serif' },
  { value: 'monospace', label: 'Monospace' },
] as const;

/** The attribute theme.css keys on; present only away from the default. */
export const DOCUMENT_FONT_ATTRIBUTE = 'data-doc-font';

/** The `font-family` value theme.css hands to the document's blocks. */
export const DOCUMENT_FONT_PROPERTY = '--doc-font-family';

/**
 * The `font-family` value for a stored setting: a preset's stack, or the
 * quoted name followed by the theme's sans font. Empty for the default.
 */
export function documentFontStack(value: string | undefined): string {
  const name = value ? normalizeFontFamilyName(value) : '';
  if (!name) return '';
  if (Object.hasOwn(DOCUMENT_FONT_PRESETS, name)) {
    return DOCUMENT_FONT_PRESETS[name as keyof typeof DOCUMENT_FONT_PRESETS];
  }
  return `${quoteFontFamily(name)}, var(--font-sans), sans-serif`;
}

/**
 * Put `value` on `root` (the document element). At the default both the
 * attribute and the property are removed, so nothing in theme.css applies.
 */
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
