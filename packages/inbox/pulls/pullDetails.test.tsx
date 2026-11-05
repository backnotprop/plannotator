/**
 * The details' checks on the numbers a real project has. What regresses: a hundred green rows pushing the labels out of
 * the column, skipped checks counted as passed, and what needs eyes hidden behind the line.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullCheck, InboxPullDetailsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { byState, checkLabels, CheckRows, cutMiddle, DetailsStatus, PullDetails, reviewWords, usePullDetails } = (hasDom ? await import('./PullDetails') : {}) as typeof import('./PullDetails');
const { inboxApi, InboxApiError } = (hasDom ? await import('../api') : {}) as typeof import('../api');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

const many = (n: number, state: InboxPullCheck['state'], note?: string): InboxPullCheck[] =>
  Array.from({ length: n }, (_, i) => ({ name: `${note ?? state} ${i}`, state, ...(note ? { note } : {}) }));
const draw = (checks: InboxPullCheck[]) => act(() => root.render(<CheckRows checks={checks} />));
const rows = () => host.querySelectorAll('[data-pull-details-check]').length;
const line = () => host.querySelector('button');

test.if(hasDom)('a few passed checks are a list; many are a line that says what ran and what was skipped, and opens', () => {
  draw(many(3, 'pass'));
  expect(rows()).toBe(3);
  expect(line()).toBeNull();

  draw([...many(14, 'pass'), ...many(29, 'pass', 'Skipped')]);
  expect(rows()).toBe(0);
  expect(line()!.textContent).toBe('14 passed, 29 skipped');
  act(() => line()!.click());
  expect(rows()).toBe(43);
  expect(host.querySelectorAll('[data-pull-details-check]')[0]!.textContent).toContain('pass 0');
});

test.if(hasDom)('what needs eyes stays on the column, whatever else folds, and is first when opened', () => {
  draw([...many(120, 'pass'), ...many(1, 'pending'), ...many(2, 'fail')]);
  expect(rows()).toBe(3);
  expect(host.querySelectorAll('[data-pull-details-check]')[0]!.getAttribute('data-pull-details-check')).toBe('fail');
  expect(line()!.textContent).toBe('120 passed');
  act(() => line()!.click());
  expect(host.querySelectorAll('[data-pull-details-check]')[0]!.getAttribute('data-pull-details-check')).toBe('fail');
});

test.if(hasDom)('a failure says how it failed, on its one line; many running fold into the line with the passed and skipped', () => {
  const failed: InboxPullCheck[] = [
    { name: 'Test new and changed tests when deployed (adapter, 1/5) / build', workflow: 'build-and-test', state: 'fail', note: 'Failed', url: 'https://ci.example/1' },
    { name: 'thank you, next', workflow: 'build-and-test', state: 'fail', note: 'Timed out' },
  ];
  draw([...many(113, 'pass'), ...many(7, 'pass', 'Skipped'), ...many(14, 'pending'), ...failed]);
  const shown = [...host.querySelectorAll('[data-pull-details-check]')];
  expect(shown.map((row) => row.getAttribute('data-pull-details-check'))).toEqual(['fail', 'fail']);
  expect(shown[0]!.querySelector('.ib-prd-rname')!.textContent).toBe('Test new and changed tests when deployed (adapter, 1/5)');
  expect(shown[0]!.querySelector('.ib-prd-rstate')!.textContent).toBe('Failed');
  expect(shown[1]!.querySelector('.ib-prd-rstate')!.textContent).toBe('Timed out');
  expect(shown[0]!.querySelector('a')!.getAttribute('href')).toBe('https://ci.example/1');
  expect(line()!.textContent).toBe('14 running, 113 passed, 7 skipped');
  act(() => line()!.click());
  expect(rows()).toBe(136);
  expect(host.querySelectorAll('[data-pull-details-check]')[2]!.getAttribute('data-pull-details-check')).toBe('pending');
  // A few running stay on the column.
  act(() => root.render(<CheckRows key="few" checks={[...many(3, 'pending'), ...many(40, 'pass')]} />));
  expect(rows()).toBe(3);
  expect(line()!.textContent).toBe('40 passed');
});

test.if(hasDom)("a check's own name: the job, without the workflow before it or the called job after it, unless two would read the same", () => {
  const a = { name: 'Test new and changed tests when deployed (adapter, 1/5) / build', workflow: 'build-and-test', state: 'fail' as const };
  const b = { name: 'lint', workflow: 'ci', state: 'pass' as const };
  const c = { name: 'e2e (chromium) / build', state: 'pass' as const };
  const d = { name: 'e2e (chromium) / deploy', state: 'pass' as const };
  const labels = checkLabels([a, b, c, d]);
  expect([labels.get(a), labels.get(b), labels.get(c), labels.get(d)]).toEqual(['Test new and changed tests when deployed (adapter, 1/5)', 'lint', 'e2e (chromium) / build', 'e2e (chromium) / deploy']);
});

test.if(hasDom)("an answer with no comments list, from an older server, leaves the bar's control standing", () => {
  const partial = { key: 'k', description: null, labels: [], reviewers: [], checks: [] } as unknown as InboxPullDetailsAnswer;
  act(() => root.render(<DetailsStatus data={partial} />));
  expect(host.querySelector('[data-pull-details-comments]')).toBeNull();
});

test.if(hasDom)("a bot that only commented neither leads the reviewers nor says where the review stands", () => {
  const bot = { login: 'acme-deploy-bot', state: 'commented' as const, bot: true };
  const waiting = [{ login: 'ana', state: 'waiting' as const }, { login: 'kim', state: 'waiting' as const }];
  expect(byState([bot, ...waiting]).map((r) => r.login)).toEqual(['ana', 'kim', 'acme-deploy-bot']);
  expect(reviewWords([bot, ...waiting])).toBe('Waiting');
  // Alone, it is what there is; and a person's comment still counts.
  expect(reviewWords([bot])).toBe('Commented');
  expect(reviewWords([{ login: 'ana', state: 'commented' }, ...waiting])).toBe('Commented');
  // A bot that asks for changes is heard.
  expect(reviewWords([{ ...bot, state: 'changes' }, ...waiting])).toBe('Changes requested');
});

const layer = {
  key: 'github.com/acme/web#7', platform: 'github', host: 'github.com', repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7',
  title: 'T', author: 'ana', mine: false, requested: true, state: 'open', base: 'main', head: 'b7', head_repo: 'acme/web', additions: 1, deletions: 0,
  files: 1, review: null, approved_by: null, reviewers: [], checks: 'success', updated_at: '2026-11-03T09:00:00.000Z', merged_at: null,
} as InboxPull;
const panel = (heldUntil: number | null, onRetry = () => {}) =>
  act(() => root.render(<PullDetails layer={layer} description="" data={null} failed heldUntil={heldUntil} onRetry={onRetry} forge="GitHub" panel={{ current: null }} phone={false} inDiff={() => false} onClose={() => {}} onFile={() => {}} />));

test.if(hasDom)('held by the forge: it says so and until when, and Try again waits for that time instead of failing unseen', () => {
  panel(Date.now() + 45 * 60_000);
  const note = host.querySelector('[data-pull-details-failed]')!;
  expect(note.getAttribute('data-pull-details-failed')).toBe('held');
  expect(note.textContent).toMatch(/^github\.com asked to slow down\. Try again after \d{1,2}:\d{2}/);
  expect(note.querySelector('button')).toBeNull();
  let asked = 0;
  panel(Date.now() - 1, () => asked++);
  const again = host.querySelector('[data-pull-details-failed] button') as HTMLButtonElement;
  expect(again.textContent).toBe('Try again');
  act(() => again.click());
  expect(asked).toBe(1);
  // Not held: the forge did not answer, and Try again is there.
  panel(null);
  expect(host.querySelector('[data-pull-details-failed]')!.textContent).toBe('GitHub did not answer about the reviewers and checks. Try again');
});

test.if(hasDom)('the details are read again when the PR moves (a new head), and a held answer carries its time', async () => {
  const keep = inboxApi.pullDetails;
  const asked: string[] = [];
  let answer: () => Promise<InboxPullDetailsAnswer> = async () => ({ key: layer.key, description: null, labels: [], reviewers: [], checks: [], comments: [] }) as unknown as InboxPullDetailsAnswer;
  inboxApi.pullDetails = ((key: string) => {
    asked.push(key);
    return answer();
  }) as typeof inboxApi.pullDetails;
  const seen: { held: number | null }[] = [];
  function Probe({ stamp, pr = layer.key }: { stamp: string; pr?: string }) {
    const read = usePullDetails(pr, stamp);
    seen.push({ held: read.heldUntil });
    return null;
  }
  try {
    await act(async () => root.render(<Probe stamp="a\u0000t1" />));
    await act(async () => root.render(<Probe stamp="a\u0000t1" />));
    expect(asked.length).toBe(1);
    await act(async () => root.render(<Probe stamp="b\u0000t2" />));
    expect(asked.length).toBe(2);
    answer = async () => {
      throw new InboxApiError(429, 'pull_details_held', 'github.com asked to slow down.', null, 1_234);
    };
    // Another PR, held: no answer shown yet, so the hold is what it says.
    await act(async () => root.render(<Probe stamp="c\u0000t3" pr="github.com/acme/web#8" />));
    expect(asked.length).toBe(3);
    expect(seen[seen.length - 1]!.held).toBe(1_234);
  } finally {
    inboxApi.pullDetails = keep;
  }
});

test.if(hasDom)('a check name cut in its middle keeps more of its end, so two that share a long start stay apart', () => {
  const start = 'Test new and changed tests when deployed to the preview environment with the adapter and the cache';
  const linux = cutMiddle(`${start} (linux, 1/5)`, 40);
  const windows = cutMiddle(`${start} (windows, 1/5)`, 40);
  expect(linux).not.toBe(windows);
  expect(linux.startsWith('Test new and')).toBe(true);
  expect(linux.endsWith('(linux, 1/5)')).toBe(true);
  expect(Array.from(linux.replace('…', '')).length).toBeLessThanOrEqual(40);
  // Short enough, it is whole; never half of a character.
  expect(cutMiddle('lint', 40)).toBe('lint');
  expect(cutMiddle('🎉'.repeat(30), 10)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});
