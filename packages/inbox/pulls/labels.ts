/** How the Pull requests page names things: repositories, hosts, forges and people's initials. */
import type { InboxPullStack } from '@plannotator/core/inbox-types';

/** The repository's own name (`billing-svc` for `northwind/billing-svc`). */
export function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf('/') + 1);
}

/** "Open on GitHub" / "Open on GitLab". */
export function forgeName(stack: Pick<InboxPullStack, 'platform'>): string {
  return stack.platform === 'gitlab' ? 'GitLab' : 'GitHub';
}

/** A host as the list names it: "GitHub" and "GitLab" for github.com and gitlab.com, else the host itself. */
export function hostName(host: string): string {
  return host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : host;
}

/**
 * A person's initials, drawn while their picture loads or when it cannot: two words give two letters ("mara-lee" →
 * "ML"), one gives one ("priya" → "P"); never a pair that reads as "pull request" or "merge request" on this page
 * ("PR", "MR"): the first letter alone then.
 */
export function initials(login: string): string {
  const parts = login.split(/[-_. ]+/).filter(Boolean);
  const two = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  return two === 'PR' || two === 'MR' ? two[0]! : two;
}

/**
 * Each repository's label in the list, by `inboxPullRepoKey`: its own name ("ledger"), with as much of its path as
 * tells it apart from another listed repository of the same name ("platform/ledger", "finance/ledger"), and its host
 * when the paths are the same on two hosts.
 */
export function repoLabels(repos: readonly Pick<InboxPullStack, 'host' | 'repo'>[]): Map<string, string> {
  const unique = new Map<string, { host: string; repo: string }>();
  for (const r of repos) unique.set(`${r.host}/${r.repo}`.toLowerCase(), { host: r.host, repo: r.repo });
  const all = [...unique.entries()];
  const tail = (repo: string, n: number) => repo.split('/').slice(-n).join('/');
  const out = new Map<string, string>();
  for (const [key, { host, repo }] of all) {
    const depth = repo.split('/').length;
    let n = 1;
    const clash = (k: number) => all.some(([other, o]) => other !== key && tail(o.repo, k).toLowerCase() === tail(repo, k).toLowerCase());
    while (n < depth && clash(n)) n++;
    out.set(key, clash(n) ? `${host}/${repo}` : tail(repo, n));
  }
  return out;
}
