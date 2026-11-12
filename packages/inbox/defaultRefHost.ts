/**
 * Where an `owner/repo#123` links in a thread whose project has no repo (a folder without a git origin): on the host
 * most of the person's projects use, so a mostly-GitLab Inbox links it on GitLab. Read from the projects every list
 * read already brings (`repo_host`, api.ts): no request and no git of its own.
 *
 * The rule: count each project with a repo once, by its normalized host (a remote that names no host, or an SSH
 * alias, counts as github.com, as `forgeRefLinks` reads it). The most counted wins. A tie that includes github.com is
 * github.com; another tie is the alphabetically first host. No project with a repo, or a winner `forgeRefLinks`
 * cannot form a link for (an opaque self-hosted name), is github.com.
 *
 * ui's `crossRepoRefsWithoutRepo` seam gets the answer (every message's `InlineMarkdown` re-renders when it changes),
 * and the thread's Links view reads it through `useDefaultRefHost`.
 */
import { useSyncExternalStore } from 'react';
import { classifyForgeHost, normalizeForgeHost } from '@plannotator/core/forge-refs';
import { setCrossRepoRefsWithoutRepo } from '@plannotator/ui/components/InlineMarkdown';

const GITHUB = 'github.com';

export function defaultRefHost(projects: readonly { repo_host?: string | null }[]): string {
  const counts = new Map<string, number>();
  for (const project of projects) {
    if (project.repo_host === undefined) continue;
    const host = normalizeForgeHost(project.repo_host) ?? GITHUB;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best = 0;
  for (const count of counts.values()) best = Math.max(best, count);
  const tied = [...counts].filter(([, count]) => count === best).map(([host]) => host);
  if (tied.length === 0 || tied.includes(GITHUB)) return GITHUB;
  const winner = tied.sort()[0]!;
  return classifyForgeHost(winner) ? winner : GITHUB;
}

let lastList: readonly { repo_host?: string | null }[] | null = null;
let current = GITHUB;
const listeners = new Set<() => void>();

/** A list read's projects: the host again, only when the list changed, and ui told only when the host did. */
export function learnDefaultRefHost(projects: readonly { repo_host?: string | null }[]): void {
  if (projects === lastList) return;
  lastList = projects;
  const host = defaultRefHost(projects);
  if (host === current) return;
  current = host;
  setCrossRepoRefsWithoutRepo({ host });
  for (const listener of listeners) listener();
}

/** Tests only: back to github.com with no list learnt. */
export function resetDefaultRefHost(): void {
  lastList = null;
  current = GITHUB;
  setCrossRepoRefsWithoutRepo({ host: GITHUB });
  for (const listener of listeners) listener();
}

/** The host an `owner/repo#123` in a repoless thread links on now. */
export function useDefaultRefHost(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}
