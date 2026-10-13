/** Small display helpers for the Inbox window. Pure. */

import { inboxAgentName } from '@plannotator/core/inbox-types';

/** How the person sees an agent: the name it gave, else its host's name, else "An agent" (core's rule, shared with the server's drafts). */
export const agentName = inboxAgentName;

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const COUNT = new Intl.NumberFormat('en-US');

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Oct 3" this year, "Sep 2, 2025" another year: a day that never reads as this year's when it is not. */
function dayOf(date: Date, now: Date): string {
  return date.getFullYear() === now.getFullYear() ? DAY.format(date) : DAY_YEAR.format(date);
}

/** "10:42 AM" today, "Oct 3" before, "Sep 2, 2025" in another year. */
export function shortTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return sameDay(date, now) ? TIME.format(date) : dayOf(date, now);
}

/**
 * When something happened, as a line in a thread says it: "8:22 PM" today,
 * "Oct 10, 8:22 PM" another day, "Sep 2, 2025, 8:22 PM" another year. A
 * yesterday's message and today's reply never both read "8:22 PM".
 */
export function whenTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return sameDay(date, now) ? TIME.format(date) : `${dayOf(date, now)}, ${TIME.format(date)}`;
}

/** "Friday, October 10, 2026 at 8:22 PM": the whole moment, for a time's hover text. */
export function fullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : FULL.format(date);
}

/** "1,284": a count with its thousands separated. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** "today", "yesterday", else "Oct 3": a day in a sentence ("Asked by Claude Code, today"). */
export function dayWords(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return dayOf(date, now);
}

/** "Oct 3, 10:42 AM": a moment on the Decisions page ("Sep 2, 2025, 10:42 AM" in another year). */
export function dateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${dayOf(date, now)}, ${TIME.format(date)}`;
}

/** Always the clock time ("10:42 AM"), for lines that say when within a thread. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME.format(date);
}

/** "2 questions" from two up (the count in plain words); nothing for one or none. */
export function questionCount(open: number): string {
  return open >= 2 ? `${formatCount(open)} questions` : '';
}

/** "1 thread", "1,284 threads". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
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
