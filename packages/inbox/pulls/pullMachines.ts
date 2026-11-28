/**
 * The PR board across linked machines (inbox-machines.md, "The PR board"): a PR only a linked machine lists carries
 * `machine` on the merged board, and every read of it (its diff, files, details, an author's picture, a picture in its
 * text) and every change (close, reopen, merge) goes to that machine, whose gh / glab lists it. Learned from each
 * merged board read, which replaces what the last one taught: a PR this machine lists again is this machine's.
 *
 * A linked machine's PR that leaves the board (merged or closed there, a read without it) stays that machine's (the
 * owner, 2026-11-23: what is open stays open; 2026-11-24: whatever works on one computer works across computers): a
 * page open on it, or reopened on it after a reload, still reads it there, where that machine keeps it
 * (`GET pulls/pull`, inbox-pull-departed.ts). Each linked machine's PR is remembered in this browser (`LEFT_KEY`, the
 * last `LEFT_MAX`) until this machine lists it.
 */
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxUrl } from '../inboxUrl';

/** The linked machines' PRs on the last board read. */
const byKey = new Map<string, string>();
/** `host\nlogin` of an author only a linked machine's PRs name, and that machine (this one's avatar route does not know them). */
const byAuthor = new Map<string, string>();
/** Every linked machine's PR a board named, with its machine, oldest first: those that left it since too. */
let left: Map<string, string> | null = null;
const LEFT_KEY = 'plannotator.inbox.pullMachinesLeft';
const LEFT_MAX = 300;

function leftMap(): Map<string, string> {
  if (left) return left;
  left = new Map();
  try {
    const saved = JSON.parse(window.localStorage.getItem(LEFT_KEY) ?? '[]') as unknown;
    if (Array.isArray(saved)) {
      for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') left.set(entry[0], entry[1]);
    }
  } catch {
    // Storage off: kept for this page only.
  }
  return left;
}

function saveLeft(map: Map<string, string>): void {
  while (map.size > LEFT_MAX) map.delete(map.keys().next().value!);
  try {
    window.localStorage.setItem(LEFT_KEY, JSON.stringify([...map]));
  } catch {
    // Storage off: kept for this page only.
  }
}

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
  // Every linked machine's PR is remembered with its machine (a reload may come between its last board and the one
  // without it); one this machine lists is this machine's again.
  const seen = leftMap();
  let changed = false;
  for (const pull of answer.pulls) {
    if (!pull.machine) changed = seen.delete(pull.key) || changed;
    else if (seen.get(pull.key) !== pull.machine) {
      seen.delete(pull.key);
      seen.set(pull.key, pull.machine);
      changed = true;
    }
  }
  if (changed) saveLeft(seen);
  return answer;
}

/** A PR whose machine answered that it is not linked here any more: this machine reads it from now on. */
export function forgetPullMachine(key: string): void {
  byKey.delete(key);
  const seen = leftMap();
  if (seen.delete(key)) saveLeft(seen);
}

/**
 * A machine the person unlinked here: the PRs remembered as its go back to this machine. One unlinked elsewhere (on
 * it, or while this window was closed) is learned at its PR's next read, which answers `machine_not_linked`
 * (routePull.ts `forgetPullMachine`).
 */
export function forgetPullMachines(machine: string): void {
  for (const [key, id] of byKey) if (id === machine) byKey.delete(key);
  for (const [author, id] of byAuthor) if (id === machine) byAuthor.delete(author);
  const seen = leftMap();
  let changed = false;
  for (const [key, id] of [...seen]) if (id === machine) changed = seen.delete(key) || changed;
  if (changed) saveLeft(seen);
}

/** The linked machine that lists this PR (or listed it last, before it left the board), or null for this machine's own. */
export function pullMachine(key: string): string | null {
  return byKey.get(key) ?? leftMap().get(key) ?? null;
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
  left = new Map();
  try {
    window.localStorage.removeItem(LEFT_KEY);
  } catch {
    // Storage off.
  }
}
