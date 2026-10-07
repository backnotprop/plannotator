/** Small display helpers for the Inbox window. Pure. */

import type { InboxAuthor } from '@plannotator/core/inbox-types';

/** The hosts whose marks the window draws, keyed by `author.host`. */
export const HOST_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  pi: 'Pi',
  opencode: 'OpenCode',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** How the person sees an agent: the name it gave, else its host's name, else "An agent". */
export function agentName(author: InboxAuthor | null | undefined): string {
  if (!author || author.kind !== 'agent') return 'An agent';
  if (author.name) return author.name;
  if (author.host) return HOST_NAMES[author.host] ?? author.host;
  return 'An agent';
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "10:42 AM" today, "Oct 3" before. */
export function shortTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? TIME.format(date) : DAY.format(date);
}

/** Always the clock time ("10:42 AM"), for lines that say when within a thread. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME.format(date);
}

/** "2 questions" from two up (the count in plain words); nothing for one or none. */
export function questionCount(open: number): string {
  return open >= 2 ? `${open} questions` : '';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "412.6 MB", "3.1 KB", "512 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** An absolute path with the home folder written as `~`. */
export function tildePath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const trimmed = home.replace(/[\\/]+$/, '');
  if (path === trimmed) return '~';
  if (path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}\\`)) return `~${path.slice(trimmed.length)}`;
  return path;
}
