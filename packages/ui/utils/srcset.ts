/**
 * One `srcset` candidate: its URL and its descriptors (`2x`, `640w`), the descriptors joined by
 * one space and empty when there are none.
 */
export interface SrcsetCandidate {
  url: string;
  descriptors: string;
}

const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';

/**
 * Split a `srcset` the way the HTML spec does ("parse a srcset attribute"): a candidate's URL
 * runs to the next whitespace, so a comma inside it (a `data:image/png;base64.
 */
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  const n = srcset.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(srcset[i]!) || srcset[i] === ',')) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !isSpace(srcset[i]!)) i++;
    let url = srcset.slice(start, i);
    let descriptors = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      let depth = 0;
      for (; i < n; i++) {
        const char = srcset[i];
        if (char === '(') depth++;
        else if (char === ')' && depth > 0) depth--;
        else if (char === ',' && depth === 0) break;
      }
      descriptors = srcset.slice(start, i).trim().split(/\s+/).filter(Boolean).join(' ');
    }
    if (url) candidates.push({ url, descriptors });
  }
  return candidates;
}

export function serializeSrcset(candidates: readonly SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptors }) => (descriptors ? `${url} ${descriptors}` : url))
    .join(', ');
}
