/**
 * How Settings → Reviews in the Inbox saves: the same stored values code
 * review's Settings → Reviews reads and writes, so a change made in either
 * shows in the other.
 *
 * - Every diff setting on the page (layout, wrapping, line numbers,
 *   backgrounds, change marks, changed words, tab size, whole file, moved
 *   code, the code font and its size, Power Up and its motion) goes through
 *   `chooseDiffOption` (diffOptions.ts): its cookie at once and config.json
 *   `diffOptions` through POST /api/inbox/settings `diff_options`.
 * - Semantic changes goes through the config store, whose write-back
 *   (inboxServerSync, theme.ts) saves config.json
 *   `reviewAnalysis.semanticDiff` (reviewAnalysis.ts).
 * - Power Up's model and key are the Inbox's opinion route, which keeps them
 *   in the same data dir as code review (secrets/sem-diff-opinion.json). A key
 *   write carries this page's session, as every Inbox write does.
 *
 * The rows the Inbox leaves out (`INBOX_REVIEW_ROWS`) are ones it cannot
 * honour and whose value lives only in this browser's cookies or in code
 * review's server: Minimap, Hide whitespace, Hover cards, Auto-mark viewed,
 * the Git and Jujutsu defaults, and Call flow. Package changes is not passed,
 * so it is not drawn.
 */
import { configStore } from '@plannotator/ui/config';
import type { ReviewSettingChange, ReviewSettingsRows } from '@plannotator/ui/components/settings/reviewSettingsControls';
import type { OpinionFetch } from '@plannotator/ui/components/settings/PowerUpSettings';
import { pageServerSession } from '../api';
import { chooseDiffOption, isInboxDiffSetting } from '../diffOptions';

export const INBOX_REVIEW_ROWS: Partial<ReviewSettingsRows> = {
  hideWhitespace: false,
  minimap: false,
  hoverCards: false,
  defaultDiffViews: false,
  autoViewed: false,
  callFlow: false,
};

export const inboxReviewSettingChange: ReviewSettingChange = (key, value) => {
  if (isInboxDiffSetting(key)) chooseDiffOption(key, value as never);
  else configStore.set(key, value);
};

/** The opinion route's requests: a write (POST, DELETE) carries the page's serverSession in its JSON body. */
export const inboxOpinionFetch: OpinionFetch = (route, init) => {
  const method = init?.method ?? 'GET';
  const session = pageServerSession();
  if (method === 'GET' || !session) return fetch(route, init);
  const sent = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return fetch(route, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sent, serverSession: session }),
  });
};
