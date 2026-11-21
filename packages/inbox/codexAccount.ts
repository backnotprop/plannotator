/**
 * Settings → Agents' Codex account line (read-only, from `GET /api/inbox/codex/account`): what the row says. The
 * limits read as the Accounts page writes them ("5h 21% · week 40%": used, not left), and a limit at 90% or more
 * adds when it resets. No row while Codex is not found or its account could not be read.
 */
import type { InboxCodexAccount, InboxCodexLimit } from '@plannotator/core/inbox-types';

/** At this much used, the line says when the limit resets (the Accounts page's amber point). */
export const CODEX_LIMIT_NEAR = 90;

export interface CodexAccountLine {
  /** The row's value: the plan, "API key", "Signed in" or "Not signed in". */
  value: string;
  /** The limits line, or null. */
  limits: string | null;
  /** Not signed in: the row says to run `codex login`. */
  signIn: boolean;
}

/** A limit's name: 5h, week, else its length. */
export function codexLimitLabel(limit: InboxCodexLimit, index: number): string {
  const mins = limit.window_mins;
  if (mins === null) return index === 0 ? '5h' : 'week';
  if (mins === 300) return '5h';
  if (mins === 10080) return 'week';
  return mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
}

/** When a limit resets, in the person's own clock: a time today, a weekday this week, else a date. */
export function codexResetText(at: string | null, now = new Date()): string | null {
  const when = at ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (when.toDateString() === now.toDateString()) return time;
  if (when.getTime() - now.getTime() < 6 * 86_400_000) return `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function codexAccountLine(account: InboxCodexAccount | null, now = new Date()): CodexAccountLine | null {
  if (!account) return null;
  if (account.state === 'signed_out') return { value: 'Not signed in', limits: null, signIn: true };
  if (account.state !== 'signed_in') return null;
  if (account.kind === 'api_key') return { value: 'API key', limits: null, signIn: false };
  if (account.kind === 'other') return { value: 'Signed in', limits: null, signIn: false };
  const limits = account.limits ?? [];
  const parts = limits.map((limit, i) => `${codexLimitLabel(limit, i)} ${limit.used_percent}%`);
  const near = limits.map((limit, i) => ({ limit, i })).filter(({ limit }) => limit.used_percent >= CODEX_LIMIT_NEAR);
  for (const { limit, i } of near) {
    const resets = codexResetText(limit.resets_at, now);
    if (resets) parts.push(`${codexLimitLabel(limit, i)} resets ${resets}`);
  }
  return { value: account.plan ?? 'ChatGPT', limits: parts.length > 0 ? parts.join(' · ') : null, signIn: false };
}
