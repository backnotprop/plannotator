export const MAX_FONT_FAMILY_LENGTH = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function normalizeFontFamilyName(name: string): string {
  return name.replace(CONTROL_CHARS, '').trim().slice(0, MAX_FONT_FAMILY_LENGTH).trim();
}

export function quoteFontFamily(name: string): string {
  const clean = normalizeFontFamilyName(name);
  if (!clean) return '';
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function monoFontStack(name: string | undefined): string {
  const quoted = name ? quoteFontFamily(name) : '';
  return quoted ? `${quoted}, monospace` : '';
}

const FONT_SIZE_RANGE: Record<'px' | 'pt' | 'rem' | 'em', readonly [number, number]> = {
  px: [6, 72],
  pt: [5, 54],
  rem: [0.375, 4.5],
  em: [0.375, 4.5],
};

export function normalizeCssFontSize(size: string | undefined): string {
  if (!size) return '';
  const match = /^(\d{1,3}(?:\.\d{1,3})?)(px|pt|rem|em)$/i.exec(size.trim());
  if (!match) return '';
  const value = Number(match[1]);
  const unit = match[2].toLowerCase() as keyof typeof FONT_SIZE_RANGE;
  const [min, max] = FONT_SIZE_RANGE[unit];
  return value >= min && value <= max ? `${value}${unit}` : '';
}
