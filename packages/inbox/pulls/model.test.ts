/**
 * The Pull requests page's words and choices under the worst case (break-ui on #2590). What regresses:
 *  - with several agents on one stack, a verdict on a layer reaching an agent that never linked it (below its own);
 *  - a stack named by the thread of an agent that linked only a layer higher up;
 *  - a failed or partial read saying "Nothing open in your projects", or dropping its PRs without a word;
 *  - gh not installed told as "signed out"; a host's PRs past the search's cap left out without a count;
 *  - a long chain drawn as a row of marks past its line; a fork's second layer read as "After";
 *  - one layer headed "Landing order"; a layer on a branch no PR has said to be "Based on" it as if it lands;
 *  - two repositories of one name in the list told apart by nothing;
 *  - initials that read as "PR" or "MR" on this page;
 *  - a rail of files that share their name and last folder, each row the same text.
 */
import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxPullLink, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import {
  chainMarks,
  initials,
  ladderHeading,
  landsNextLayer,
  layerBaseWords,
  layerVerdictLink,
  nextLayer,
  otherLayerAgents,
  pullsEmptyWords,
  pullsNotices,
  railRows,
  repoLabels,
  stackLink,
  stackTitle,
} from './model';

function pr(fields: Partial<InboxPull> & { number: number; head: string }): InboxPull {
  const repo = fields.repo ?? 'northwind/payments-gateway';
  return {
    key: `github.com/${repo}#${fields.number}`.toLowerCase(),
    platform: 'github',
    host: 'github.com',
    repo,
    url: `https://github.com/${repo}/pull/${fields.number}`,
    title: `PR ${fields.number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head_repo: repo,
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: '2026-11-03T10:00:00.000Z',
    merged_at: null,
    ...fields,
  };
}

const link = (thread: string, fields: Partial<InboxPullLink> = {}): InboxPullLink => ({
  via: 'url',
  thread_id: thread,
  thread_subject: `Subject of ${thread}`,
  project_id: 'prj_1',
  agent: { host: 'claude-code', session: `ses_${thread}`, name: null },
  last: { message_id: `msg_${thread}`, preview: 'Up.', at: '2026-11-03T10:00:00.000Z' },
  guide: null,
  ...fields,
});

/** A chain of `n` layers on main: #1 at the bottom. */
const chain = (n: number) => Array.from({ length: n }, (_, i) => pr({ number: i + 1, head: `l${i + 1}`, base: i === 0 ? 'main' : `l${i}` }));

const answer = (fields: Partial<InboxPullsAnswer>): InboxPullsAnswer => ({ fetched_at: null, hosts: [], pulls: [], links: {}, projects: {}, cards: {}, ...fields });

describe('several agents on one stack (#2)', () => {
  const layers = chain(4);
  const [stack] = inboxPullStacks(layers);
  // Claude opened the stack at #1; Codex linked only #3, higher up.
  const links = { [layers[0]!.key]: link('claude'), [layers[2]!.key]: link('codex') };

  test("the stack is Claude's (the bottom's); each agent's verdicts are its own layers and the ones above them, never below", () => {
    expect(stackLink(stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[0]!, stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[1]!, stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[2]!, stack!, links)!.thread_id).toBe('codex');
    expect(layerVerdictLink(layers[3]!, stack!, links)!.thread_id).toBe('codex');
    expect(otherLayerAgents(stack!, links).map((o) => [o.link.thread_id, o.layers.map((l) => l.number)])).toEqual([['codex', [3, 4]]]);
  });

  test('a layer under the only linked one, with two agents on the stack, goes to neither', () => {
    const upper = { [layers[2]!.key]: link('codex'), [layers[3]!.key]: link('cursor') };
    expect(layerVerdictLink(layers[0]!, stack!, upper)).toBeNull();
    // One agent only: the whole stack is its.
    expect(layerVerdictLink(layers[0]!, stack!, { [layers[2]!.key]: link('codex') })!.thread_id).toBe('codex');
  });

  test("the stack is named by the bottom layer's thread, never by a thread that linked only a layer higher up", () => {
    expect(stackTitle(stack!, links)).toBe('Subject of claude');
    expect(stackTitle(stack!, { [layers[2]!.key]: link('codex') })).toBe('PR 1');
  });
});

describe('what the list says when it could not read everything (#5, #6, #8, #26)', () => {
  test('a host that timed out with nothing read: "didn\'t answer", never "Nothing open"', () => {
    const model = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: null, error: 'unavailable' }], clis: { gh: 'signed_in' }, unsigned: [] });
    const notices = pullsNotices(model);
    expect(notices.map((n) => n.line)).toEqual(["GitHub didn't answer; its pull requests aren't shown."]);
    expect(pullsEmptyWords(model, notices)).toMatchObject({ kind: 'unread', head: "GitHub didn't answer" });
  });

  test('a rate limit with a last read: shown, and said to be the last read', () => {
    const model = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', error: 'rate_limited', last_read: '2026-11-03T09:00:00.000Z' }] });
    expect(pullsNotices(model).map((n) => n.key)).toEqual(['rate_limited:true']);
  });

  test('gh not installed is not "signed out"; one host answering while another is unsigned says so in the list', () => {
    const missing = answer({ clis: { gh: 'missing', glab: 'missing' }, unsigned: ['github.com'], projects: { 'github.com/northwind/payments-gateway': ['prj_1'] } });
    expect(pullsEmptyWords(missing).kind).toBe('missing');
    const signedOut = answer({ clis: { gh: 'signed_out', glab: 'signed_out' }, unsigned: ['github.com'], projects: { 'github.com/northwind/payments-gateway': ['prj_1'] } });
    expect(pullsEmptyWords(signedOut).kind).toBe('signed-out');
    const half = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }], clis: { gh: 'signed_in', glab: 'signed_out' }, unsigned: ['gitlab.com'] });
    expect(pullsNotices(half).map((n) => n.key)).toEqual(['unsigned:glab']);
  });

  test('more than one read takes: "Showing 100 of 133", with the forge\'s own list', () => {
    const model = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', capped: { shown: 100, total: 133 } }] });
    const [notice] = pullsNotices(model);
    expect(notice).toMatchObject({ head: 'Showing 100 of 133', link: { href: 'https://github.com/pulls' } });
  });
});

describe('stack shapes (#11, #16, #20, #22)', () => {
  test('a chain of 12 draws the first two, "+8", the last two; five or fewer draw every one', () => {
    const marks = chainMarks(chain(12));
    expect(marks.map((m) => ('more' in m ? `+${m.more}` : m.number))).toEqual([1, 2, '+8', 11, 12]);
    expect(chainMarks(chain(5))).toHaveLength(5);
  });

  test('a fork: the second layer on one branch reads "Also on", and the layer after the fork point is the first only', () => {
    const base = pr({ number: 9100, head: 'eu-migration', base: 'main' });
    const a = pr({ number: 9101, head: 'eu-a', base: 'eu-migration' });
    const b = pr({ number: 9102, head: 'eu-b', base: 'eu-migration' });
    const [stack] = inboxPullStacks([base, a, b]);
    expect(layerBaseWords(a, stack!)).toBe('After #9100');
    expect(layerBaseWords(b, stack!)).toBe('Also on #9100');
    expect(nextLayer(stack!, a.key)).toBeNull();
    expect(nextLayer(stack!, base.key)!.number).toBe(9101);
  });

  test('one layer is headed by its noun, not "Landing order"', () => {
    expect(ladderHeading(inboxPullStacks([pr({ number: 1, head: 'x' })])[0]!)).toBe('Pull request');
    expect(ladderHeading(inboxPullStacks([pr({ number: 1, head: 'x', platform: 'gitlab' })])[0]!)).toBe('Merge request');
    expect(ladderHeading(inboxPullStacks(chain(2))[0]!)).toBe('Landing order');
  });

  test('a layer on a branch no PR has: "no open pull request", and no "Lands next"', () => {
    const top = pr({ number: 7, head: 'dr/failover', base: 'dr/route53' });
    const above = pr({ number: 8, head: 'dr/drill', base: 'dr/failover' });
    const [stack] = inboxPullStacks([top, above]);
    expect(layerBaseWords(top, stack!)).toBe('Based on dr/route53 (no open pull request)');
    expect(landsNextLayer(stack!)).toBeNull();
    expect(landsNextLayer(inboxPullStacks(chain(3))[0]!)!.number).toBe(1);
  });
});

describe('names in the list (#14, #27)', () => {
  test('two repositories called "ledger" are told apart by their path', () => {
    const labels = repoLabels([
      { host: 'github.com', repo: 'platform/ledger' },
      { host: 'github.com', repo: 'finance/ledger' },
      { host: 'github.com', repo: 'northwind/web-app' },
    ]);
    expect(labels.get('github.com/platform/ledger')).toBe('platform/ledger');
    expect(labels.get('github.com/finance/ledger')).toBe('finance/ledger');
    expect(labels.get('github.com/northwind/web-app')).toBe('web-app');
    const twoHosts = repoLabels([
      { host: 'github.com', repo: 'acme/ledger' },
      { host: 'ghe.acme.io', repo: 'acme/ledger' },
    ]);
    expect(new Set(twoHosts.values()).size).toBe(2);
  });

  test('initials never read as PR or MR', () => {
    expect(initials('priya-rao')).toBe('P');
    expect(initials('mara.reyes')).toBe('M');
    expect(initials('mara-lee')).toBe('ML');
    expect(initials('tomas')).toBe('T');
  });
});

describe('the review rail (#17)', () => {
  const regions = ['us-east-1', 'us-west-2', 'eu-west-1'].map((r) => `infra/terraform/environments/production/${r}/networking/vpc-peering/main.tf`);

  test('files that share their name and last folder are grouped under distinct folder headings', () => {
    const rows = railRows([...regions, 'README.md']);
    const folders = rows.filter((r) => r.kind === 'folder').map((r) => r.text);
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toContain('us-east-1/…/vpc-peering/');
    expect(rows.filter((r) => r.kind === 'file')).toHaveLength(4);
  });

  test('distinct files stay a flat list, each with its folder', () => {
    const rows = railRows(['src/a.ts', 'src/b.ts']);
    expect(rows).toEqual([
      { kind: 'file', path: 'src/a.ts', dir: 'src/', name: 'a.ts' },
      { kind: 'file', path: 'src/b.ts', dir: 'src/', name: 'b.ts' },
    ]);
  });
});
