export function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function camelToKebab(input: string): string {
  return input.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function kebabToCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z')) return word + 'es';
  if (word.endsWith('y')) return word.slice(0, -1) + 'ies';
  return word + 's';
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, c => map[c]);
}

export function template(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
