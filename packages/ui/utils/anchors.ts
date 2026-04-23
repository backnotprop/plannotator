export function normalizeAnchorText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .trim();
}

export function decodeAnchorHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '').split('?')[0]?.trim();
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded || null;
  } catch {
    // Keep malformed fragments non-fatal; the caller can still attempt lookup.
    return raw;
  }
}

export function slugifyHeadingAnchor(text: string): string {
  return normalizeAnchorText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function legacySlugifyHeadingAnchor(text: string): string {
  return normalizeAnchorText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getHeadingAnchorAliases(text: string): string[] {
  const aliases = [slugifyHeadingAnchor(text), legacySlugifyHeadingAnchor(text)]
    .filter(Boolean);
  return [...new Set(aliases)];
}
