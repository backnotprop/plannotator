import { useMemo, useRef } from 'react';
import { inboxPullRefOfKey, type InboxListRow, type InboxMessageWire, type InboxProjectRepo, type InboxThread } from '@plannotator/core/inbox-types';
import { bareRefNumbers } from './threadLinks';

type RefRepo = { display: string; host?: string };

const sameRepo = (a: InboxProjectRepo, b: InboxProjectRepo) => a.display.toLowerCase() === b.display.toLowerCase() && (a.host ?? '').toLowerCase() === (b.host ?? '').toLowerCase();

export function attachedRefRepo(message: Pick<InboxMessageWire, 'id' | 'body'>, pullKeys: readonly string[]): InboxProjectRepo | null {
  const attached = pullKeys.flatMap((key) => {
    const ref = key.endsWith(':pull') ? null : inboxPullRefOfKey(key);
    return ref ? [{ number: ref.number, repo: { display: ref.repo, host: ref.host } }] : [];
  });
  if (attached.length === 0) return null;
  const drawn = bareRefNumbers(message.id, message.body);
  if (drawn.length === 0) return null;
  const loose = [...message.body.matchAll(/(?<!\w)#(\d+)(?!\w)/g)].map((match) => Number(match[1]));
  let found: InboxProjectRepo | null = null;
  for (const number of new Set([...drawn, ...loose])) {
    const repos = attached.filter((pull) => pull.number === number).map((pull) => pull.repo);
    const one = repos[0];
    if (!one || repos.some((repo) => !sameRepo(repo, one))) return null;
    if (found && !sameRepo(found, one)) return null;
    found = one;
  }
  return found;
}

export function messageRefRepo(message: Pick<InboxMessageWire, 'id' | 'body' | 'from_project'>, threadRepo: InboxProjectRepo | null | undefined, pullKeys: readonly string[]): InboxProjectRepo | null {
  const from = message.from_project;
  if (from) return from.repo === undefined ? null : (from.repo ?? threadRepo ?? null);
  return threadRepo ?? attachedRefRepo(message, pullKeys);
}

export function threadPullKeys(thread: Pick<InboxThread, 'pull_keys'>, row: Pick<InboxListRow, 'pulls'> | null | undefined): string[] {
  const headline = row?.pulls?.headline.key;
  return [...new Set([...(thread.pull_keys ?? []), ...(headline ? [headline] : [])])];
}

export function useMessageRefRepos(thread: Pick<InboxThread, 'messages' | 'pull_keys'> & { project: { repo?: InboxProjectRepo | null } }, row: Pick<InboxListRow, 'pulls'> | null | undefined) {
  const keys = threadPullKeys(thread, row).join('\n');
  const threadRepo = thread.project.repo ?? null;
  const shared = useRef(new Map<string, RefRepo>()).current;
  return useMemo(() => {
    const pullKeys = keys ? keys.split('\n') : [];
    const byId = new Map<string, { repo: InboxProjectRepo | null; refRepo: RefRepo | null }>();
    for (const message of thread.messages) {
      const repo = messageRefRepo(message, threadRepo, pullKeys);
      const id = repo ? `${repo.host ?? ''}\u0000${repo.display}` : '';
      if (repo && !shared.has(id)) shared.set(id, { display: repo.display, ...(repo.host ? { host: repo.host } : {}) });
      byId.set(message.id, { repo, refRepo: repo ? shared.get(id)! : null });
    }
    return {
      repoOf: (id: string) => (byId.has(id) ? byId.get(id)!.repo : threadRepo),
      refRepoOf: (id: string) => byId.get(id)?.refRepo ?? null,
    };
  }, [thread.messages, threadRepo, keys, shared]);
}
