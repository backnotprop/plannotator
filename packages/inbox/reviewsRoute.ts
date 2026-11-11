/** `#pulls` is a permanent alias of `#reviews`: links to it live outside this repository, so it keeps working and its parameters are kept. */
export function reviewsAlias(hash: string): string | null {
  const match = /^#pulls(?:=[^&]*)?(?=&|$)/.exec(hash);
  return match ? `#reviews${hash.slice(match[0].length)}` : null;
}
