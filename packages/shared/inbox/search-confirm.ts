/**
 * Picking a search group's rows, best first, and, for a query with an exact
 * phrase, confirming each candidate the index found against its text
 * (search.ts reads the text; `inboxSearchPhrasesHold` in
 * @plannotator/core/inbox-search is the rule). Node-safe, no Bun import.
 */

export interface InboxSearchHit {
  doc: number;
  score: number;
}

/**
 * How many candidates past a group's page the text confirms for its total.
 * Past that, the candidates not read count as found (the index's own count),
 * so a large total may run a little high, while every row shown is confirmed.
 */
export const INBOX_SEARCH_CONFIRM_COUNT_MAX = 64;

const better = (a: InboxSearchHit, b: InboxSearchHit) => b.score - a.score || a.doc - b.doc;

/** The best `k` hits, best first (ties: the older document first, so the order is total). A partial selection when `k` is small. */
export function topOf(list: InboxSearchHit[], k: number): InboxSearchHit[] {
  if (k > 64 || list.length <= k * 4) return list.sort(better).slice(0, k);
  const best: InboxSearchHit[] = [];
  for (const hit of list) {
    if (best.length === k && better(hit, best[k - 1]!) >= 0) continue;
    let i = best.length === k ? k - 1 : best.length;
    if (best.length < k) best.push(hit);
    while (i > 0 && better(hit, best[i - 1]!) < 0) {
      best[i] = best[i - 1]!;
      i--;
    }
    best[i] = hit;
  }
  return best;
}

/**
 * The best `need` hits the text confirms (`holds`), best first, and the
 * group's total: the hits confirmed, plus those left unread once `max`
 * candidates past the page were read. Candidates are read best first, so a
 * page costs what it shows plus the false ones before it.
 */
export function confirmedTop(list: InboxSearchHit[], need: number, holds: (doc: number) => boolean, max = INBOX_SEARCH_CONFIRM_COUNT_MAX): { top: InboxSearchHit[]; total: number } {
  // Most candidates hold: the page and the count's reads first, the whole order only when false ones ran them out.
  let order = topOf(list, Math.min(list.length, need + max));
  const top: InboxSearchHit[] = [];
  let confirmed = 0;
  let budget = max;
  let i = 0;
  for (; i < list.length; i++) {
    if (top.length >= need) {
      if (budget === 0) break;
      budget -= 1;
    }
    if (i === order.length) order = topOf(list, list.length);
    const hit = order[i]!;
    if (!holds(hit.doc)) continue;
    confirmed += 1;
    if (top.length < need) top.push(hit);
  }
  return { top, total: confirmed + (list.length - i) };
}
