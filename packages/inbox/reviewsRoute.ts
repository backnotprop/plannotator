export function reviewsAlias(hash: string): string | null {
  const match = /^#pulls(?:=[^&]*)?(?=&|$)/.exec(hash);
  return match ? `#reviews${hash.slice(match[0].length)}` : null;
}
