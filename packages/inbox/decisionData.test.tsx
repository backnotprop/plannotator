import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DecisionDataSummary, DecisionGroup } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { DecisionData, axisTop, insightsOf, labelStep, waitWords } = (hasDom ? await import('./components/DecisionData') : {}) as typeof import('./components/DecisionData');

const NOW = Date.parse('2026-11-05T12:00:00');
const DAY = 86_400_000;

const group = (over: Partial<DecisionGroup> = {}): DecisionGroup => ({ id: 'g', label: 'harbor', answered: 40, skipped: 2, set_aside: 2, replaced: 0, offered: 30, taken: 20, median_wait_ms: 3_600_000, ...over });
const model = (over: Partial<DecisionDataSummary> = {}): DecisionDataSummary => ({
  range: { since: NOW - 90 * DAY, until: NOW, earliest: NOW - 40 * DAY },
  counts: { answered: 40, skipped: 2, set_aside: 2, replaced: 0 },
  settled_in_words: 0,
  waiting: 3,
  days: [{ day: '2026-11-01', answered: 7, skipped: 1, own_words: 2 }],
  pace: { fast: { offered: 0, taken: 0 }, slow: { offered: 0, taken: 0 } },
  stopped_wait: { n: 0, median_ms: null },
  recommendation: { offered: 30, taken: 20 },
  projects: [group()],
  agents: [group({ id: 'Claude Code', label: 'Claude Code', host: 'claude-code' })],
  history: { asked: 50, answered: 40, earliest: NOW - 40 * DAY },
  trends: [],
  rate_min: 20,
  median_min: 5,
  ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let counts: { url: string; signal: AbortSignal | undefined }[] = [];
let answer: (url: string) => Promise<Response> = async () => new Response(JSON.stringify(model()));
let sessions: unknown[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  counts = [];
  sessions = [{ project: { id: 'prj_a', name: 'harbor', root: '/made/up/harbor' }, sessions: [{ session: 'ses-a', host: 'claude-code', started_at: '2026-11-01T00:00:00.000Z', last_seen_at: '2026-11-05T00:00:00.000Z', busy: false, idle_since: null, last_thread: null }] }];
  answer = async () => new Response(JSON.stringify(model()));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/inbox/sessions')) return new Response(JSON.stringify({ serverSession: 's', home: '/made/up', projects: sessions }));
    if (url.includes('/api/inbox/decision-data')) {
      counts.push({ url, signal: init?.signal ?? undefined });
      return answer(url);
    }
    return new Response('{}');
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  delete (window.HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(width = 700) {
  host = document.createElement('div');
  document.body.appendChild(host);
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  act(() => {
    root = createRoot(host!);
    root.render(<DecisionData />);
  });
  return host;
}

const never = () => new Promise<Response>(() => {});

test.skipIf(!hasDom)('Ask never waits on the count: while it runs, Ask is there and usable, and the numbers have a quiet place', async () => {
  answer = never;
  const el = await open();
  await until(() => el.querySelector('[data-ask-go]') !== null, 'Ask');
  expect(el.querySelector('[data-decision-counting]')).not.toBeNull();
  expect(el.querySelector('[data-decision-insights]')).toBeNull();
  expect(el.querySelector('[data-decision-empty]')).toBeNull();
  const input = el.querySelector('input[aria-label="Ask about a decision"]') as HTMLInputElement;
  expect(input.disabled).toBe(false);
});

test.skipIf(!hasDom)('the quiet place waits a moment before it shows, so a count that lands soon never flashes it', async () => {
  answer = never;
  const begun = performance.now();
  const el = await open();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  if (performance.now() - begun < 100) expect(el.querySelector('[data-decision-counting]')).toBeNull();
  await until(() => el.querySelector('[data-decision-counting]') !== null, 'the quiet place');
});

test.skipIf(!hasDom)('on a small store the numbers land first: no quiet place flashes before them', async () => {
  const el = await open();
  await until(() => el.querySelector('[data-decision-insights]') !== null, 'Insights');
  expect(el.querySelector('[data-decision-counting]')).toBeNull();
  expect(counts.length).toBe(1);
});

test.skipIf(!hasDom)('a store with nothing asked says so, alone, as the approved picture does', async () => {
  answer = async () => new Response(JSON.stringify(model({ history: { asked: 0, answered: 0, earliest: null }, waiting: 0, counts: { answered: 0, skipped: 0, set_aside: 0, replaced: 0 }, agents: [], projects: [], days: [] })));
  const el = await open();
  await until(() => el.querySelector('[data-decision-empty]') !== null, 'the empty state');
  expect(el.querySelector('[data-decision-ask]')).toBeNull();
  expect(el.querySelector('[data-decision-insights]')).toBeNull();
});

test.skipIf(!hasDom)('a new install has Ask and what it has so far; Insights wait for a week or 20 decisions', async () => {
  const early = (answered: number, age: number) => model({ history: { asked: answered + 1, answered, earliest: NOW - age * DAY }, counts: { answered, skipped: 0, set_aside: 0, replaced: 0 }, waiting: 1, range: { since: NOW - 90 * DAY, until: NOW, earliest: NOW - age * DAY } });
  answer = async () => new Response(JSON.stringify(early(2, 1)));
  const el = await open();
  await until(() => el.querySelector('[data-decision-early]') !== null, 'too early');
  expect(el.querySelector('[data-decision-ask]')).not.toBeNull();
  expect(el.querySelector('[data-decision-lede]')!.textContent).toContain('2 decisions');
  expect(el.querySelector('[data-decision-lede]')!.textContent).toContain('1 waits');
  expect(el.querySelector('[data-decision-insights]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  for (const [answered, age] of [
    [20, 1],
    [2, 8],
  ] as const) {
    answer = async () => new Response(JSON.stringify(early(answered, age)));
    const later = await open();
    await until(() => later.querySelector('[data-decision-insights]') !== null, `Insights at ${answered} decisions, ${age} days`);
    expect(later.querySelector('[data-decision-early]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
  }
  root = null;
  host = null;
});

test.skipIf(!hasDom)('trends show as a block with the direction of each number; with none the whole block is gone', async () => {
  const el = await open();
  await until(() => el.querySelector('[data-decision-insights]') !== null, 'Insights');
  expect(el.querySelector('[data-decision-trends]')).toBeNull();
  expect(el.textContent).not.toContain('compared with the 30 before');
  act(() => root?.unmount());
  host?.remove();

  answer = async () =>
    new Response(
      JSON.stringify(
        model({
          trends: [
            { key: 'recommendations', direction: 'up', now: 0.91, was: 0.73 },
            { key: 'waits', direction: 'down', now_ms: 157 * 60_000, was_ms: 600 * 60_000 },
            { key: 'skips', direction: 'up', now: 0.14, was: 0.06 },
          ],
        }),
      ),
    );
  const shown = await open();
  await until(() => shown.querySelector('[data-decision-trends]') !== null, 'the trends');
  const lines = [...shown.querySelectorAll('[data-trend]')];
  expect(lines.map((line) => line.getAttribute('data-direction'))).toEqual(['up', 'down', 'up']);
  expect(lines[0]!.textContent).toContain('91%');
  expect(lines[0]!.textContent).toContain('73%');
  expect(lines[0]!.querySelector('.ib-dd-arrow')!.textContent).toBe('↑');
  expect(lines[1]!.textContent).toContain('2 h 37 min');
  expect(lines[1]!.querySelector('.ib-dd-arrow')!.textContent).toBe('↓');
});

test.skipIf(!hasDom)('changing the range lets the old count go and asks for the new one; the CSV follows the range', async () => {
  const el = await open();
  await until(() => el.querySelector('[data-decision-insights]') !== null, 'Insights');
  expect(counts[0]!.url).toContain('days=90');
  expect(el.querySelector('[data-decision-csv]')!.getAttribute('href')).toContain('days=90');
  answer = never;
  const radio = (label: string) => [...el.querySelectorAll('.ib-seg-o')].find((o) => o.textContent === label)!.querySelector('input') as HTMLInputElement;
  await act(async () => radio('30 days').click());
  await until(() => counts.length === 2, 'the 30-day count');
  expect(counts[1]!.url).toContain('days=30');
  expect(el.querySelector('[data-decision-insights]')).not.toBeNull();
  await act(async () => radio('All').click());
  await until(() => counts.length === 3, 'the All count');
  expect(counts[1]!.signal!.aborted).toBe(true);
  expect(counts[2]!.url).toContain('days=0');
  expect(counts[2]!.signal!.aborted).toBe(false);
  expect(el.querySelector('[data-decision-csv]')!.getAttribute('href')).toContain('days=0');
});

test.skipIf(!hasDom)('a reader who leaves mid-count lets it go, so the server stops', async () => {
  answer = never;
  await open();
  await until(() => counts.length === 1, 'the count');
  expect(counts[0]!.signal!.aborted).toBe(false);
  act(() => root?.unmount());
  root = null;
  expect(counts[0]!.signal!.aborted).toBe(true);
});

test.skipIf(!hasDom)('a count that fails leaves Ask working and no place waiting forever', async () => {
  answer = async () => new Response(JSON.stringify({ error: 'no' }), { status: 500 });
  const el = await open();
  await until(() => el.querySelector('[data-decision-ask]') !== null, 'Ask');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(el.querySelector('[data-decision-counting]')).toBeNull();
  expect(el.querySelector('[data-decision-insights]')).toBeNull();
});

test.skipIf(!hasDom)('a narrow section lists who asks; a wider one has the table; a range with no answers offers to show everything', async () => {
  const wide = await open(700);
  await until(() => wide.querySelector('[data-decision-insights]') !== null, 'Insights');
  expect(wide.querySelector('table[class="ib-dd-tbl"] th')?.textContent).toBeTruthy();
  expect(wide.querySelector('ul.ib-dd-gl')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  const narrow = await open(340);
  await until(() => narrow.querySelector('ul.ib-dd-gl') !== null, 'the list');
  expect(narrow.querySelector('[data-group="agent"]')!.textContent).toContain('40 decisions');
  act(() => root?.unmount());
  host?.remove();

  const tight = await open(568);
  await until(() => tight.querySelector('ul.ib-dd-gl') !== null, 'the list at 568');
  expect(tight.querySelector('[data-group] table')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  answer = async (url) => new Response(JSON.stringify(url.includes('days=0') ? model() : model({ counts: { answered: 0, skipped: 0, set_aside: 0, replaced: 0 } })));
  const quiet = await open();
  await until(() => quiet.querySelector('[data-decision-filtered]') !== null, 'nothing in range');
  await act(async () => (quiet.querySelector('[data-decision-filtered] button') as HTMLButtonElement).click());
  await until(() => counts.some((c) => c.url.includes('days=0')), 'everything');
  await until(() => quiet.querySelector('[data-decision-filtered]') === null, 'the numbers');
});

test.skipIf(!hasDom)('an insight line shows only with enough behind it', () => {
  const keys = (m: DecisionDataSummary) => insightsOf(m).map((insight) => insight.key);
  expect(keys(model())).toEqual([]);
  expect(keys(model({ agents: [group({ offered: 20, taken: 15 })] }))).toEqual(['taken']);
  expect(keys(model({ agents: [group({ offered: 19, taken: 19 })] }))).toEqual([]);
  expect(keys(model({ agents: [group({ offered: 20, taken: 14 })] }))).toEqual([]);
  expect(keys(model({ stopped_wait: { n: 5, median_ms: 60_000 } }))).toEqual(['stopped']);
  expect(keys(model({ stopped_wait: { n: 4, median_ms: 60_000 } }))).toEqual([]);
  expect(keys(model({ agents: [group({ replaced: 5 })] }))).toEqual(['replaced']);
  expect(keys(model({ agents: [group({ replaced: 4 })] }))).toEqual([]);
  expect(keys(model({ projects: [group({ answered: 17, skipped: 2, set_aside: 1 })] }))).toEqual(['closed']);
  expect(keys(model({ projects: [group({ answered: 17, skipped: 1, set_aside: 1 })] }))).toEqual([]);
  expect(keys(model({ pace: { fast: { offered: 20, taken: 18 }, slow: { offered: 20, taken: 14 } } }))).toEqual(['pace']);
  expect(keys(model({ pace: { fast: { offered: 20, taken: 18 }, slow: { offered: 19, taken: 14 } } }))).toEqual([]);
  expect(keys(model({ settled_in_words: 1 }))).toEqual(['words']);
});

test.skipIf(!hasDom)('the chart stays readable however much history there is', () => {
  for (const most of [1, 2, 3, 5, 7, 11, 25, 41, 57, 301]) {
    const top = axisTop(most);
    expect(top).toBeGreaterThanOrEqual(most);
    expect(Number.isInteger(top / 2)).toBe(true);
  }
  for (const band of [40, 12, 3, 1, 0.3, 0.05]) expect(labelStep(band) * band).toBeGreaterThanOrEqual(54);
  expect(waitWords(20_000)).toBe('under a minute');
  expect(waitWords(157 * 60_000)).toBe('2 h 37 min');
  expect(waitWords(36 * 3_600_000)).toBe('2 days');
});
