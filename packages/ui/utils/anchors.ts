export function decodeAnchorHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '').split('?')[0]?.trim();
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded || null;
  } catch {
    return raw;
  }
}
