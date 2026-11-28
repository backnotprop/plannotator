/**
 * The "↓ N new" pill's count (thread/helpers.ts `newBelow`) looked up by id (the pane's `watch`) is the count the
 * sweep of the whole thread gave, and marks the same messages passed: which are counted, in which order, and which the
 * person has had on screen. What regresses: a count or a passed mark that differs from the sweep's in any state of the
 * marks (`data-arrival`, `data-new`, `data-sighted`), a message drawn or behind a fold, passed or not, at the end or
 * not, the tab shown or not; or a scroll with nothing left to count that reads the thread.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { describe, expect, test } from 'bun:test';
import { newBelow, type PillWatch } from './helpers';

const hasDom = typeof document !== 'undefined';

const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} }) as DOMRect;

/** A seeded run of numbers in [0, 1): the same cases every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

interface Case {
  body: HTMLElement;
  watch: PillWatch;
  passed: string[];
  mark: boolean;
}

function makeCase(random: () => number): Case {
  const body = document.createElement('div');
  const scrollHeight = 4000;
  const scrollTop = random() < 0.3 ? 3200 : Math.floor(random() * 3000);
  Object.defineProperty(body, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(body, 'clientHeight', { value: 800 });
  Object.defineProperty(body, 'scrollTop', { value: scrollTop });
  body.getBoundingClientRect = () => rect(0, 800);
  const arrivals = new Set<string>();
  const atOpen = new Set<string>();
  const byId = new Map<string, HTMLElement>();
  const passed: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `msg_${i}`;
    const arrival = random() < 0.4;
    const fresh = random() < 0.4;
    if (arrival) arrivals.add(id);
    if (fresh) atOpen.add(id);
    if (random() < 0.25) passed.push(id);
    // Behind a fold: in the sets, not drawn.
    if (random() < 0.15) continue;
    const article = document.createElement('article');
    article.setAttribute('data-message-article', id);
    if (arrival) article.setAttribute('data-arrival', '');
    if (fresh) article.setAttribute('data-new', '');
    if ((arrival || fresh) && random() < 0.25) article.setAttribute('data-sighted', '');
    const top = Math.floor(random() * 2400) - 600;
    article.getBoundingClientRect = () => rect(top, 200);
    body.appendChild(article);
    byId.set(id, article);
  }
  return { body, watch: { arrivals, atOpen, article: (id) => byId.get(id) ?? null }, passed, mark: random() < 0.7 };
}

const ids = (found: HTMLElement[]) => found.map((a) => a.getAttribute('data-message-article'));

describe.skipIf(!hasDom)('the pill by id', () => {
  test('counts and marks passed exactly as the sweep of the whole thread, in every state of the marks', () => {
    const random = seeded(7);
    let counted = 0;
    for (let n = 0; n < 400; n++) {
      const c = makeCase(random);
      document.body.appendChild(c.body);
      try {
        const swept = new Set(c.passed);
        const watched = new Set(c.passed);
        const bySweep = newBelow(c.body, swept, c.mark);
        const byId = newBelow(c.body, watched, c.mark, c.watch);
        expect({ n, count: ids(byId), passed: [...watched].sort() }).toEqual({ n, count: ids(bySweep), passed: [...swept].sort() });
        if (bySweep.length > 0) counted++;
      } finally {
        c.body.remove();
      }
    }
    // The cases reach both sides: some count something, some nothing.
    expect(counted).toBeGreaterThan(40);
    expect(counted).toBeLessThan(360);
  });

  test('with nothing left to count (none new, or every new one passed), nothing of the thread is read', () => {
    const body = document.createElement('div');
    let reads = 0;
    body.querySelectorAll = (() => {
      reads++;
      return [] as unknown as NodeListOf<Element>;
    }) as typeof body.querySelectorAll;
    body.getBoundingClientRect = () => {
      reads++;
      return rect(0, 800);
    };
    const article = () => {
      reads++;
      return null;
    };
    expect(newBelow(body, new Set(), true, { arrivals: new Set(), atOpen: new Set(), article })).toEqual([]);
    expect(newBelow(body, new Set(['msg_1', 'msg_2']), true, { arrivals: new Set(['msg_1']), atOpen: new Set(['msg_2']), article })).toEqual([]);
    expect(reads).toBe(0);
  });
});
