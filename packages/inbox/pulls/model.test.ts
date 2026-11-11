import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull, type InboxPullLink, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxPullItems } from '@plannotator/core/inbox-types';
import { initials, repoLabels } from './labels';
import { layerPill, ladderHeading, pullCount, pullFilterOf, pullGroups, pullRows, pullViewOf, rowLine, rowMeta, stackTitle, type PullFilter } from './model';
import { pullsEmptyWords, pullsNotices } from './notices';
import { chainMarks, landsNextLayer, layerBaseWords, layerPosition, layerVerdictLink, nextLayer, stackLink, stackVerdictLink } from './topology';

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

const chain = (n: number) => Array.from({ length: n }, (_, i) => pr({ number: i + 1, head: `l${i + 1}`, base: i === 0 ? 'main' : `l${i}` }));

const answer = (fields: Partial<InboxPullsAnswer>): InboxPullsAnswer => ({ fetched_at: null, hosts: [], pulls: [], links: {}, projects: {}, cards: {}, ...fields });

describe('several agents on one stack (#2)', () => {
  const layers = chain(4);
  const [stack] = inboxPullStacks(layers);
  const links = { [layers[0]!.key]: link('claude'), [layers[2]!.key]: link('codex') };

  test("the stack is Claude's (the bottom's); each agent's verdicts are its own layers and the ones above them, never below", () => {
    expect(stackLink(stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[0]!, stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[1]!, stack!, links)!.thread_id).toBe('claude');
    expect(layerVerdictLink(layers[2]!, stack!, links)!.thread_id).toBe('codex');
    expect(layerVerdictLink(layers[3]!, stack!, links)!.thread_id).toBe('codex');
  });

  test('a layer under the only linked one, with two agents on the stack, goes to neither', () => {
    const upper = { [layers[2]!.key]: link('codex'), [layers[3]!.key]: link('cursor') };
    expect(layerVerdictLink(layers[0]!, stack!, upper)).toBeNull();
    expect(layerVerdictLink(layers[0]!, stack!, { [layers[2]!.key]: link('codex') })!.thread_id).toBe('codex');
  });

  test("the stack is named by the bottom layer's thread, never by a thread that linked only a layer higher up", () => {
    expect(stackTitle(stack!, links)).toBe('Subject of claude');
    expect(stackTitle(stack!, { [layers[2]!.key]: link('codex') })).toBe('PR 1');
  });

  test("a fork: a layer on A takes A's agent, never a sibling's that comes before it in the list", () => {
    const a = pr({ number: 1, head: 'a', base: 'main' });
    const b = pr({ number: 2, head: 'b', base: 'a' });
    const c = pr({ number: 3, head: 'c', base: 'a' });
    const [fork] = inboxPullStacks([a, b, c]);
    const forked = { [a.key]: link('claude'), [b.key]: link('codex') };
    expect(layerVerdictLink(c, fork!, forked)!.thread_id).toBe('claude');
  });

  test("a fork: a layer on B takes B's agent, though its cousin C (another agent) comes just before it in the list", () => {
    const a = pr({ number: 1, head: 'a', base: 'main' });
    const b = pr({ number: 2, head: 'b', base: 'a' });
    const c = pr({ number: 3, head: 'c', base: 'a' });
    const d = pr({ number: 4, head: 'd', base: 'b' });
    const [fork] = inboxPullStacks([a, b, c, d]);
    expect(fork!.layers.map((l) => l.number)).toEqual([1, 2, 3, 4]);
    const forked = { [b.key]: link('claude'), [c.key]: link('codex') };
    expect(layerVerdictLink(d, fork!, forked)!.thread_id).toBe('claude');
    expect(layerVerdictLink(c, fork!, forked)!.thread_id).toBe('codex');
  });

  test("a Whole stack verdict goes to the stack's one review thread, its lowest linked layer's, whoever linked a layer above", () => {
    expect(stackVerdictLink(layers[3]!, stack!, links)!.thread_id).toBe('claude');
    expect(stackVerdictLink(layers[1]!, stack!, links)!.thread_id).toBe('claude');
    expect(stackVerdictLink(layers[0]!, stack!, { [layers[2]!.key]: link('codex') })!.thread_id).toBe('codex');
    const theirs = { ...layers[0]!, mine: false };
    const [mixed] = inboxPullStacks([theirs, ...layers.slice(1)]);
    expect(stackVerdictLink(theirs, mixed!, links)).toBeNull();
    expect(stackVerdictLink(layers[1]!, mixed!, links)!.thread_id).toBe('codex');
  });
});

describe("the agent on the row's third line (the owner on #2608)", () => {
  test('one review thread, however it began: "#48201 · Review thread with Claude Code · …"; an ended agent, "OpenCode ended"', () => {
    const one = pr({ number: 48201, head: 'x', checks: 'pending' });
    const [item] = inboxPullItems(inboxPullStacks([one]), () => true);
    expect(rowLine(item!, link('t', { via: 'owner' }))).toBe('#48201 · Review thread with Claude Code · checks running');
    expect(rowMeta(item!, link('t', { via: 'owner' })).agent).toMatchObject({ host: 'claude-code', name: 'Claude Code', words: 'Review thread with Claude Code' });
    expect(rowLine(item!, link('t'))).toBe('#48201 · Review thread with Claude Code · checks running');
    const ended = link('t', { via: 'owner', agent: { host: 'opencode', session: 's', name: null, ended: true } });
    expect(rowLine(item!, ended)).toBe('#48201 · OpenCode ended · checks running');
    expect(rowMeta(item!, null).agent).toBeNull();
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
    expect(pullsNotices(half).map((n) => n.line)).toEqual(["glab isn't signed in to gitlab.com, so its pull requests aren't shown."]);
  });

  test('a self-hosted forge is never put on one CLI by its name: both are named, or the one installed', () => {
    const both = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }], clis: { gh: 'signed_in', glab: 'signed_out' }, unsigned: ['code.corp.example'] });
    expect(pullsNotices(both).map((n) => n.line)).toEqual(["Neither gh nor glab is signed in to code.corp.example, so its pull requests aren't shown."]);
    const noGlab = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }], clis: { gh: 'signed_in', glab: 'missing' }, unsigned: ['gitlab.corp.example'] });
    expect(pullsNotices(noGlab).map((n) => n.line)).toEqual(["gh isn't signed in to gitlab.corp.example, so its pull requests aren't shown."]);
  });

  test('more than one read takes: "Showing 100 of 133", with the forge\'s own list', () => {
    const model = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', capped: { shown: 100, total: 133 } }] });
    const [notice] = pullsNotices(model);
    expect(notice).toMatchObject({ head: 'Showing 100 of 133', link: { href: 'https://github.com/pulls' } });
  });

  test("Others failing alone is said of Others only: its last read shown, else pull requests by others aren't; never \"Nothing open\"", () => {
    const none = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', others_error: 'unavailable' }] });
    expect(pullsNotices(none).map((n) => n.line)).toEqual(["GitHub didn't answer; pull requests by others aren't shown."]);
    expect(pullsEmptyWords(none).kind).toBe('unread');
    const kept = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', others_error: 'rate_limited', others_last_read: '2026-11-03T09:00:00.000Z' }] });
    expect(pullsNotices(kept).map((n) => n.line)).toEqual(['GitHub asked to slow down; showing its last read.']);
    const both = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: null, error: 'unavailable', others_error: 'unavailable' }] });
    expect(pullsNotices(both).map((n) => n.key)).toEqual(['unavailable:false']);
  });

  test("what Others left out or failed to read is said where Others shows (All, Others), never in Mine or To review", () => {
    const cut = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', capped: { shown: 12, total: null, of: 'others' }, others_error: 'unavailable' }] });
    expect(pullsNotices(cut).map((n) => n.line)).toEqual(["GitHub didn't answer; pull requests by others aren't shown.", 'Not every pull request on github.com was read.']);
    expect(pullsNotices(cut, 'others')).toHaveLength(2);
    expect(pullsNotices(cut, 'mine')).toEqual([]);
    expect(pullsNotices(cut, 'review')).toEqual([]);
    const own = answer({ hosts: [{ cli: 'gh', host: 'github.com', login: 'dana', capped: { shown: 50, total: 80 } }] });
    expect(pullsNotices(own, 'mine').map((n) => n.key)).toEqual(['capped:github.com']);
  });

  test('a read not limited to the projects never counts what it shows against the forge total, and is never "Nothing open"', () => {
    const model = answer({ hosts: [{ cli: 'glab', host: 'gitlab.com', login: 'dana', capped: { shown: 3, total: null } }], projects: { 'gitlab.com/a/b': ['prj_1'] } });
    const [notice] = pullsNotices(model);
    expect(notice).toMatchObject({ line: 'Not every merge request on gitlab.com was read: it has more than one read takes.', link: { href: 'https://gitlab.com/dashboard/merge_requests' } });
    expect(pullsEmptyWords(model).kind).toBe('unread');
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

  test('"Layer N of M" counts a layer\'s own line of the stack: a fork\'s sibling, listed before it, is not under it', () => {
    const base = pr({ number: 9100, head: 'eu-migration', base: 'main' });
    const a = pr({ number: 9101, head: 'eu-a', base: 'eu-migration' });
    const b = pr({ number: 9102, head: 'eu-b', base: 'eu-migration' });
    const c = pr({ number: 9103, head: 'eu-c', base: 'eu-b' });
    const [stack] = inboxPullStacks([base, a, b, c]);
    expect(stack!.layers.map((l) => l.number)).toEqual([9100, 9101, 9102, 9103]);
    expect(layerPosition(stack!, base.key)).toEqual({ at: 1, of: 3 });
    expect(layerPosition(stack!, a.key)).toEqual({ at: 2, of: 2 });
    expect(layerPosition(stack!, b.key)).toEqual({ at: 2, of: 3 });
    expect(layerPosition(stack!, c.key)).toEqual({ at: 3, of: 3 });
    const merged = pr({ number: 9104, head: 'eu-d', base: 'eu-c', state: 'merged', merged_at: '2026-11-03T09:00:00.000Z' });
    const top = pr({ number: 9105, head: 'eu-e', base: 'eu-d' });
    const [long] = inboxPullStacks([base, b, c, merged, top]);
    expect(layerPosition(long!, top.key)).toEqual({ at: 4, of: 4 });
    expect(layerPosition(long!, merged.key)).toBeNull();
  });

  test('one layer is headed by its noun, not "Landing order"', () => {
    expect(ladderHeading(inboxPullStacks([pr({ number: 1, head: 'x' })])[0]!)).toBe('Pull request');
    expect(ladderHeading(inboxPullStacks([pr({ number: 1, head: 'x', platform: 'gitlab' })])[0]!)).toBe('Merge request');
    expect(ladderHeading(inboxPullStacks(chain(2))[0]!)).toBe('Landing order');
  });

  test('a base no PR has is named, never claimed to have no open pull request; any trunk keeps "Lands next"', () => {
    const lone = pr({ number: 79, head: 'dr/failover', base: 'dr/route53', default_branch: 'main' });
    const [alone] = inboxPullStacks([lone]);
    expect(layerBaseWords(lone, alone!)).toBe('Based on dr/route53');
    for (const base of ['next', 'canary', 'stable', 'v2', 'gh-pages']) {
      const into = pr({ number: 5, head: 'x', base, default_branch: base });
      expect([base, layerBaseWords(into, inboxPullStacks([into])[0]!)]).toEqual([base, null]);
      const unknown = pr({ number: 5, head: 'x', base });
      expect([base, layerBaseWords(unknown, inboxPullStacks([unknown])[0]!)]).toEqual([base, null]);
      const low = pr({ number: 6, head: 'l', base });
      const up = pr({ number: 7, head: 'u', base: 'l' });
      const [two] = inboxPullStacks([low, up]);
      expect([base, landsNextLayer(two!)?.number, layerBaseWords(low, two!)]).toEqual([base, 6, `Based on ${base}`]);
    }
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

describe('the views and the project (approval "pr-list-filters")', () => {
  const W = 'northwind/web-app';
  const B = 'northwind/billing-svc';
  const pulls = [
    pr({ repo: W, number: 1, head: 'a' }),
    pr({ repo: W, number: 2, head: 'b', base: 'a', author: 'tomas', mine: false }),
    pr({ repo: W, number: 3, head: 'c', author: 'jun', mine: false, requested: true }),
    pr({ repo: W, number: 4, head: 'd', author: 'mei', mine: false, assigned: true }),
    pr({ repo: W, number: 5, head: 'e', author: 'tomas', mine: false }),
    pr({ repo: W, number: 6, head: 'f', author: 'mei', mine: false, state: 'draft' }),
    pr({ repo: W, number: 7, head: 'g', author: 'mei', mine: false, state: 'merged', merged_at: '2026-11-02T10:00:00.000Z' }),
    pr({ repo: B, number: 8, head: 'h' }),
    pr({ repo: B, number: 9, head: 'i', author: 'jun', mine: false, requested: true }),
  ];
  const model = answer({ pulls, projects: { [`github.com/${W}`]: ['prj_web'], [`github.com/${B}`]: ['prj_bill'] } });
  const numbers = (filter: PullFilter, project: string | null = null) =>
    pullRows(pullGroups(model, project, filter))
      .map((item) => item.stack.layers.map((l) => l.number).join('+'))
      .sort();

  test('each PR is in one view: the person wrote it, else it is asked of them (requested or assigned), else others', () => {
    expect(pullViewOf({ mine: true, requested: true, assigned: true })).toBe('mine');
    expect(pullViewOf({ mine: false, requested: true })).toBe('review');
    expect(pullViewOf({ mine: false, requested: false, assigned: true })).toBe('review');
    expect(pullViewOf({ mine: false, requested: false })).toBe('others');
  });

  test('a stack stays whole, kept when any open layer is in the view; a merged layer alone never puts it there', () => {
    expect(numbers('all')).toEqual(['1+2', '3', '4', '5', '6', '8', '9']);
    expect(numbers('mine')).toEqual(['1+2', '8']);
    expect(numbers('review')).toEqual(['3', '4', '9']);
    expect(numbers('others')).toEqual(['1+2', '5', '6']);
  });

  test('the project narrows every view; the counts the menu shows follow both', () => {
    expect(numbers('review', 'prj_bill')).toEqual(['9']);
    expect(numbers('mine', 'prj_web')).toEqual(['1+2']);
    expect(pullCount(model, null, 'all')).toBe(7);
    expect(pullCount(model, null, 'mine')).toBe(2);
    expect(pullCount(model, null, 'review')).toBe(3);
    expect(pullCount(model, null, 'others')).toBe(3);
    expect(pullCount(model, 'prj_web', 'all')).toBe(5);
    expect(pullCount(model, 'prj_bill', 'others')).toBe(0);
  });

  test('on you follows the project, not the view: an assigned PR is on the person', () => {
    expect(pullGroups(model, null).on_you.map((i) => i.focus.number).sort()).toEqual([3, 4, 9]);
    expect(pullGroups(model, 'prj_web').on_you.map((i) => i.focus.number).sort()).toEqual([3, 4]);
    const assigned = pullGroups(model, null).on_you.find((i) => i.focus.number === 4)!;
    expect(assigned.reason).toBe('assigned');
    expect(rowLine(assigned, null)).toBe('#4 · assigned to you');
    expect(layerPill(pulls[3]!)).toEqual({ text: 'Assigned to you', tone: 'you' });
  });

  test('the address: a known view, else All', () => {
    expect(pullFilterOf('review')).toBe('review');
    expect(pullFilterOf('others')).toBe('others');
    expect(pullFilterOf(null)).toBe('all');
    expect(pullFilterOf('everything')).toBe('all');
    expect(pullFilterOf('')).toBe('all');
  });
});
