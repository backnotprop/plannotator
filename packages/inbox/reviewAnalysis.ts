/**
 * Code review's "Semantic changes" switch in the Inbox (`semanticDiffEnabled`
 * in @plannotator/ui's config store, config.json `reviewAnalysis.semanticDiff`).
 * Off, the PR page and a thread's guided review draw no semantic diff
 * (useSemDiffClient.ts). The store's cookie is scoped to one host name, and
 * the Inbox may be open on another than code review (127.0.0.1, the tailnet
 * name), so config.json is what carries the choice: read from GET
 * /api/inbox/settings `review_analysis`, written through POST
 * `review_analysis` (inboxServerSync in theme.ts).
 *
 * A reader waits for the first settings read (ReaderPart in lazyParts.tsx, at
 * most READ_WAIT_MS), as it waits for the engine's advert, so a semantic
 * client never arrives after the files are drawn, and a switch that is off in
 * config.json never starts the engine on an address with no cookie.
 */

import { useSyncExternalStore } from 'react';
import { configStore } from '@plannotator/ui/config';
import { apiPost, type SettingsModel } from './api';
import { adoptSavedDiffOptions } from './diffOptions';
import { inboxUrl } from './inboxUrl';

/** GET and POST /api/inbox/settings `review_analysis` (packages/server/inbox-review-analysis.ts). Absent from an older Inbox. */
export interface InboxReviewAnalysis {
  semantic_diff: boolean | null;
}

/** The longest a reader waits for the first settings read before it draws with the page's cookie. */
export const READ_WAIT_MS = 5_000;

let adopted = false;
/** The first settings read has answered, failed, or been waited for long enough. True until one starts. */
let read = true;
const listeners = new Set<() => void>();

function settle(): void {
  if (read) return;
  read = true;
  for (const listener of listeners) listener();
}

/** config.json's value wins over the cookie, from the first settings read on; null (never chosen) keeps the cookie. */
export function adoptSavedReviewAnalysis(saved: InboxReviewAnalysis | null | undefined): void {
  if (!adopted) {
    adopted = true;
    const value = saved?.semantic_diff;
    if (typeof value === 'boolean') configStore.init({ reviewAnalysis: { semanticDiff: value } });
  }
  settle();
}

/** The settings App reads (refreshSettings): the diff options and this switch. */
export function adoptSavedReviewSettings(next: Pick<SettingsModel, 'diff_options' | 'diff_style'> & { review_analysis?: InboxReviewAnalysis | null }): void {
  adoptSavedDiffOptions(next.diff_options, next.diff_style);
  adoptSavedReviewAnalysis(next.review_analysis);
}

/**
 * The page's first settings read (settingsAtLoad.ts): readers wait for it. The diff options come in with it, before
 * readers are let go, so what waits on this (the semantic client, Power Up) never starts from the cookie's
 * `diffSemantic` or `diffPowerUp` while config.json says otherwise.
 */
export function waitForReviewAnalysis(answer: Promise<object>): void {
  if (adopted) return;
  read = false;
  answer.then((next) => adoptSavedReviewSettings(next as Parameters<typeof adoptSavedReviewSettings>[0]), settle);
}

export function reviewAnalysisReadNow(): boolean {
  return read;
}

/** Resolves once the first settings read is over, or after `timeoutMs` (which counts as over). */
export function reviewAnalysisRead(timeoutMs = READ_WAIT_MS): Promise<void> {
  if (read) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settle();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      listeners.delete(done);
      resolve();
    };
    listeners.add(done);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReviewAnalysisRead(): boolean {
  return useSyncExternalStore(subscribe, reviewAnalysisReadNow, reviewAnalysisReadNow);
}

/** The config store's sync payload `reviewAnalysis` as POST /api/inbox/settings `review_analysis`; null when it carries no semantic switch. */
export function reviewAnalysisToWire(reviewAnalysis: unknown): InboxReviewAnalysis | null {
  const value = (reviewAnalysis as { semanticDiff?: unknown } | null | undefined)?.semanticDiff;
  return typeof value === 'boolean' ? { semantic_diff: value } : null;
}

export function saveReviewAnalysis(change: InboxReviewAnalysis): Promise<unknown> {
  return apiPost(inboxUrl('/settings'), { review_analysis: change });
}

/** Tests only: a fresh page. */
export function resetReviewAnalysisForTests(): void {
  adopted = false;
  read = true;
  listeners.clear();
}
