/**
 * The PR board across linked machines (inbox-machines.md, "The PR board"): a PR only a linked machine lists carries
 * `machine` on the merged board, and every read of it (its diff, files, details, an author's picture, a picture in its
 * text) and every change (close, reopen, merge) goes to that machine, whose gh / glab lists it. Learned from each
 * merged board read, which replaces what the last one taught: a PR this machine lists again is this machine's.
 */
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxUrl } from '../inboxUrl';

const byKey = new Map<string, string>();
/** `host\nlogin` of an author only a linked machine's PRs name, and that machine (this one's avatar route does not know them). */
const byAuthor = new Map<string, string>();

/** Learn from a merged board read which PRs and authors are a linked machine's. */
export function learnPullMachines(answer: InboxPullsAnswer): InboxPullsAnswer {
  byKey.clear();
  byAuthor.clear();
  const ownAuthors = new Set(answer.pulls.flatMap((pull) => (!pull.machine && pull.author ? [`${pull.host}\n${pull.author}`] : [])));
  for (const pull of answer.pulls) {
    if (!pull.machine) continue;
    byKey.set(pull.key, pull.machine);
    const author = pull.author ? `${pull.host}\n${pull.author}` : null;
    if (author && !ownAuthors.has(author) && !byAuthor.has(author)) byAuthor.set(author, pull.machine);
  }
  return answer;
}

/** The linked machine that lists this PR, or null for this machine's own. */
export function pullMachine(key: string): string | null {
  return byKey.get(key) ?? null;
}

/** A per-PR route (`/pulls/details`, `/pulls/diff`, …) on the machine that lists the PR; `query` is already encoded. */
export function pullUrl(path: string, key: string, query?: string): string {
  return inboxUrl(path, `key=${encodeURIComponent(key)}${query ? `&${query}` : ''}`, pullMachine(key));
}

/** The machine whose avatar route knows this author: a linked machine's for an author only its PRs name. */
export function avatarMachine(host: string, login: string): string | null {
  return byAuthor.get(`${host}\n${login}`) ?? null;
}

/** Tests only. */
export function resetPullMachines(): void {
  byKey.clear();
  byAuthor.clear();
}
