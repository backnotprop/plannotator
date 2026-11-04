/**
 * What the Pull requests list says about what it could not read, or read only in part, and what its empty state
 * says by cause. Never "Nothing open" while a host failed, a read was cut short, or a CLI could not ask.
 */
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { hostName } from './labels';
import type { PullFilter } from './model';

type Cli = 'gh' | 'glab';

const joinAnd = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What a forge's own list of the person's PRs is: the search the capped answer comes from. */
function forgeListUrl(host: string, cli: Cli): string {
  return cli === 'glab' ? `https://${host}/dashboard/merge_requests` : `https://${host}/pulls`;
}

/** One line the list says about what it could not read, or read only in part. */
export interface PullsNotice {
  key: string;
  /** Short, for the empty state's heading. */
  head: string;
  /** The line in the list. */
  line: string;
  /** "Open on GitHub": the forge's own list, when only part of it is shown. */
  link?: { href: string; label: string };
}

/**
 * The CLIs that could read a host no CLI here is signed in to: gh for github.com, glab for gitlab.com; any other
 * host may be either (a self-hosted GitLab's name need not say so), so both are named.
 */
function clisFor(host: string): Cli[] {
  return host === 'github.com' ? ['gh'] : host === 'gitlab.com' ? ['glab'] : ['gh', 'glab'];
}

/**
 * Why the list may be missing pull requests, one notice per cause: a host that didn't answer or asked to slow down
 * (its last read shown when there is one, else its PRs are not), a host whose searches found more than one read takes
 * ("Showing 100 of 133" when the searches were limited to the projects' repositories, else that not every one was
 * read), and a project's host no CLI here is signed in to (the CLIs that could read it not installed, or not signed
 * in there). Others (every open PR of the projects' repositories) is a read of its own: when it alone failed, the
 * notice says its last read is shown, or that pull requests by others are not.
 */
export function pullsNotices(model: Pick<InboxPullsAnswer, 'hosts' | 'clis' | 'unsigned'>, filter: PullFilter = 'all'): PullsNotice[] {
  // Mine and To review come from the person's own lists: what Others left out is not theirs to say.
  const othersShown = filter === 'all' || filter === 'others';
  const out: PullsNotice[] = [];
  for (const error of ['unavailable', 'rate_limited'] as const) {
    for (const shown of [false, true]) {
      const hosts = model.hosts.filter((h) => h.error === error && !!h.last_read === shown);
      if (hosts.length === 0) continue;
      const names = joinAnd([...new Set(hosts.map((h) => hostName(h.host)))]);
      const many = hosts.length > 1;
      const head = error === 'unavailable' ? `${names} didn't answer` : `${names} asked to slow down`;
      const tail = shown ? `showing ${many ? 'their' : 'its'} last read.` : `${many ? 'their' : 'its'} pull requests aren't shown.`;
      out.push({ key: `${error}:${shown}`, head, line: `${head}; ${tail}${error === 'rate_limited' && !shown ? ' Try again in a minute.' : ''}` });
    }
  }
  // Others (every open PR of the projects' repositories) is a read of its own: it failed while the person's own lists
  // answered. Said of Others only; a host whose own read failed already says so above.
  for (const error of othersShown ? (['unavailable', 'rate_limited'] as const) : []) {
    for (const shown of [false, true]) {
      const hosts = model.hosts.filter((h) => !h.error && h.others_error === error && !!h.others_last_read === shown);
      if (hosts.length === 0) continue;
      const names = joinAnd([...new Set(hosts.map((h) => hostName(h.host)))]);
      const head = error === 'unavailable' ? `${names} didn't answer` : `${names} asked to slow down`;
      const tail = shown ? `showing ${hosts.length > 1 ? 'their' : 'its'} last read.` : "pull requests by others aren't shown.";
      out.push({ key: `${error}:others:${shown}`, head, line: `${head}; ${tail}${error === 'rate_limited' && !shown ? ' Try again in a minute.' : ''}` });
    }
  }
  for (const h of model.hosts) {
    if (!h.capped) continue;
    const ofOthers = h.capped.of === 'others';
    if (ofOthers && !othersShown) continue;
    const forge = h.cli === 'glab' ? 'GitLab' : 'GitHub';
    const link = { href: forgeListUrl(h.host, h.cli), label: `Open on ${forge}` };
    if (typeof h.capped.total === 'number') {
      if (h.capped.total <= h.capped.shown) continue;
      out.push({ key: `capped:${h.host}`, head: `Showing ${h.capped.shown} of ${h.capped.total}`, line: `Showing ${h.capped.shown} of ${h.capped.total} from ${h.host}`, link });
    } else {
      // How many are left out is not known: Others searched only the most active repositories, or the person's own
      // searches were not limited to the projects' repositories (and found more than one read takes).
      const noun = h.cli === 'glab' ? 'merge request' : 'pull request';
      const line = ofOthers ? `Not every ${noun} on ${h.host} was read.` : `Not every ${noun} on ${h.host} was read: it has more than one read takes.`;
      out.push({ key: `capped:${h.host}`, head: `Not every ${noun} was read`, line, link });
    }
  }
  // Each host no CLI is signed in to, by the CLIs that could read it and whether they are installed.
  const groups = new Map<string, { missing: boolean; clis: Cli[]; hosts: string[] }>();
  for (const host of model.unsigned ?? []) {
    const could = clisFor(host);
    const installed = could.filter((cli) => model.clis?.[cli] !== 'missing');
    const missing = installed.length === 0;
    const clis = missing ? could : installed;
    const key = `unsigned:${missing ? 'missing' : 'signed_out'}:${clis.join('+')}`;
    const group = groups.get(key) ?? { missing, clis, hosts: [] };
    group.hosts.push(host);
    groups.set(key, group);
  }
  for (const [key, { missing, clis, hosts }] of groups) {
    const names = joinAnd(clis);
    const where = joinAnd(hosts);
    const head = missing
      ? `${names} ${clis.length > 1 ? "aren't" : "isn't"} installed`
      : clis.length > 1
        ? `Neither ${clis.join(' nor ')} is signed in to ${where}`
        : `${names} isn't signed in to ${where}`;
    const line = missing ? `${head} here, so pull requests on ${where} aren't shown.` : `${head}, so ${hosts.length > 1 ? 'their' : 'its'} pull requests aren't shown.`;
    out.push({ key, head, line });
  }
  return out;
}

const SIGN_IN_LINE = 'Pull requests show here when this computer’s gh or glab is signed in to the host of a project’s origin.';

/**
 * What the empty list says, by cause: a host that failed ("GitHub didn't answer", never "Nothing open"), a read cut
 * short, a CLI not installed, signed out, no project on GitHub or GitLab, or truly nothing open.
 */
export function pullsEmptyWords(
  model: Pick<InboxPullsAnswer, 'hosts' | 'clis' | 'unsigned' | 'projects'>,
  notices: readonly PullsNotice[] = pullsNotices(model),
): { kind: 'unread' | 'missing' | 'signed-out' | 'no-repos' | 'nothing'; head: string; lines: string[] } {
  const failed = notices.filter((n) => n.key.startsWith('unavailable:') || n.key.startsWith('rate_limited:'));
  const capped = notices.filter((n) => n.key.startsWith('capped:'));
  const unsigned = notices.filter((n) => n.key.startsWith('unsigned:'));
  if (failed.length > 0 || capped.length > 0) {
    const first = failed[0] ?? capped[0]!;
    const others = notices.filter((n) => n !== first);
    // The heading already says the first one: its line goes on from there ("Its pull requests aren't shown.").
    const rest = (n: PullsNotice) => (n.line.startsWith(`${n.head}; `) ? n.line.slice(n.head.length + 2).replace(/^./, (c) => c.toUpperCase()) : n.line);
    return { kind: 'unread', head: first.head, lines: [rest(first), ...others.map((n) => n.line)] };
  }
  if (unsigned.length > 0 && model.hosts.length === 0) {
    if (unsigned.every((n) => n.key.startsWith('unsigned:missing:'))) {
      const clis = [...new Set(unsigned.flatMap((n) => n.key.slice('unsigned:missing:'.length).split('+')))];
      return { kind: 'missing', head: `${joinAnd(clis)} ${clis.length > 1 ? "aren't" : "isn't"} installed`, lines: [...unsigned.map((n) => n.line), SIGN_IN_LINE] };
    }
    return { kind: 'signed-out', head: 'No signed-in GitHub or GitLab here', lines: [...unsigned.map((n) => n.line), SIGN_IN_LINE] };
  }
  if (model.hosts.length === 0) {
    // An older Inbox says nothing of its CLIs: the words it always had.
    if (model.clis && Object.keys(model.projects).length === 0) {
      return { kind: 'no-repos', head: 'No project here is on GitHub or GitLab', lines: ['Pull requests show here for projects whose origin is on GitHub or GitLab.'] };
    }
    return { kind: 'signed-out', head: 'No signed-in GitHub or GitLab here', lines: [SIGN_IN_LINE] };
  }
  return { kind: 'nothing', head: 'Nothing open in your projects', lines: ['Open pull requests in your projects show here.', ...unsigned.map((n) => n.line)] };
}

/** The CLIs whose hosts answered this read, for the foot ("From gh on this computer"). */
export function answeredClis(model: Pick<InboxPullsAnswer, 'hosts'>): string[] {
  return [...new Set(model.hosts.filter((h) => !h.error).map((h) => h.cli))];
}
