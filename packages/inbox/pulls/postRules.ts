/**
 * Post to GitHub/GitLab (the owner's answer C on #2590): the forge's rules for one PR, read as the review app reads
 * them (`getPRPlatformCapabilities`), and which pull request a review may be posted to.
 */
import { inboxPullIsOpen, type InboxPull } from '@plannotator/core/inbox-types';
import { getPRPlatformCapabilities } from '../../shared/pr-types';
import type { PlatformPostPull, PlatformRules } from '../guide/platform-post-types';

export { resolvePlatformDecisionAction } from '../../review-editor/reviewDecision';

/** The PR as `#platform-post` posts it, or null when it can't be: closed, merged, or its head commit unknown. */
export function postablePull(pull: InboxPull | null | undefined): PlatformPostPull | null {
  if (!pull || !pull.head_sha || !inboxPullIsOpen(pull)) return null;
  return { key: pull.key, url: pull.url, number: pull.number, title: pull.title, repo: pull.repo, host: pull.host, platform: pull.platform, head_sha: pull.head_sha, mine: pull.mine };
}

export function platformRules(pull: PlatformPostPull): PlatformRules {
  const caps = getPRPlatformCapabilities({ platform: pull.platform });
  // The person's own PR: the forge refuses their approval (and on GitHub their request for changes).
  const selfAuthored = pull.mine && caps.selfReviewBlocked;
  return {
    label: caps.label,
    mrLabel: caps.changeLabel,
    selfAuthored,
    requestChangesSupported: caps.requestChanges,
    requestChangesUnavailableReason: !caps.requestChanges
      ? `${caps.label} has no request-changes review; this posts as a comment.`
      : selfAuthored
        ? `You can't request changes on your own pull request on ${caps.label}.`
        : undefined,
  };
}

/** The posted confirmation's words (GitLab has no request-changes review: it went as a comment). */
export function postedWords(posted: { label: string; action: string }): string {
  if (posted.action === 'approve') return `Approved on ${posted.label}`;
  if (posted.action === 'request_changes' && posted.label !== 'GitLab') return `Changes requested on ${posted.label}`;
  return `Review posted on ${posted.label}`;
}
