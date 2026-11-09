/**
 * The markup a highlighted fence is drawn with, from Shiki's themed tokens.
 *
 * Pure (no DOM, no Shiki import), so the window's `highlightToHtml`
 * (`./codeHighlight`) and a host's background tokenizer (a Web Worker with its
 * own Shiki core, e.g. the Inbox's) build the same characters from the same
 * tokens.
 */

/** Shiki's `FontStyle` bitmask. Inlined so this module needs no shiki types. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

export interface ThemedTokenish {
  content: string;
  color?: string;
  bgColor?: string;
  fontStyle?: number;
  htmlStyle?: Record<string, string> | string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function tokenStyle(token: ThemedTokenish): string {
  if (typeof token.htmlStyle === 'string') return token.htmlStyle;
  const parts: string[] = [];
  if (token.htmlStyle) {
    for (const [prop, value] of Object.entries(token.htmlStyle)) parts.push(`${prop}:${value}`);
  }
  if (token.color) parts.push(`color:${token.color}`);
  if (token.bgColor) parts.push(`background-color:${token.bgColor}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle > 0) {
    if (fontStyle & FONT_STYLE_ITALIC) parts.push('font-style:italic');
    if (fontStyle & FONT_STYLE_BOLD) parts.push('font-weight:bold');
    const decorations: string[] = [];
    if (fontStyle & FONT_STYLE_UNDERLINE) decorations.push('underline');
    if (fontStyle & FONT_STYLE_STRIKETHROUGH) decorations.push('line-through');
    if (decorations.length) parts.push(`text-decoration:${decorations.join(' ')}`);
  }
  return parts.join(';');
}

/**
 * The markup for `code` from its themed lines, or null when the tokens do not
 * spell `code` exactly.
 *
 * Invariant: the rendered text must be byte-identical to the source. The
 * annotation layer addresses these blocks by text offset, so a tokenizer that
 * normalised line endings (or dropped a trailing newline) would silently
 * misplace every highlight in the block. Bail to plain text instead.
 */
export function themedLinesToHtml(lines: readonly (readonly ThemedTokenish[])[], code: string): string | null {
  let html = '';
  let plain = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      html += '\n';
      plain += '\n';
    }
    for (const token of lines[i]!) {
      plain += token.content;
      const style = tokenStyle(token);
      html += style ? `<span style="${style}">${escapeHtml(token.content)}</span>` : escapeHtml(token.content);
    }
  }
  return plain === code ? html : null;
}
