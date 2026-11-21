/**
 * Post to GitHub/GitLab (the owner's answer C on #2590): the forge's rules for one PR, read as the review app reads
 * them (`getPRPlatformCapabilities`), and which pull request a review may be posted to.
 */
import { inboxPullIsOpen, type InboxPull } from '@plannotator/core/inbox-types';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { anchorStillMatches, captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';
import { getPRPlatformCapabilities } from '../../shared/pr-types';
import type { KeptComment, PlatformPostPull, PlatformRules } from '../guide/platform-post-types';

export { resolvePlatformDecisionAction } from '../../review-editor/reviewDecision';

/**
 * A posted comment as it went: its id with what it says and where. A comment edited after it was posted keeps its id
 * but not this, so the correction counts as new: it has not gone, and the follow-up offers it.
 */
export function postedSignature(c: CodeAnnotation): string {
  return JSON.stringify([c.id, c.text ?? '', c.suggestedCode ?? '', c.conventionalLabel ?? '', c.decorations ?? [], c.filePath, c.lineStart, c.lineEnd, c.side, c.scope ?? 'line']);
}

/**
 * Comments on an agent's guided review that can go inline: the code itself vouches, their lines and those around them
 * reading the same on the PR's own diff. Any other stays as it was, and goes in the review body with its code.
 */
export function onPullDiff(comments: readonly CodeAnnotation[], guideFiles: readonly DiffFile[], pullFiles: readonly DiffFile[]): KeptComment[] {
  return comments.map((c) => (anchorStillMatches({ ...c, ...captureAnchor(c, guideFiles) }, pullFiles) ? { ...c, onPullDiff: true } : c));
}

/** The PR as `#platform-post` posts it, or null when it can't be: closed, merged, or its head commit unknown. */
export function postablePull(pull: InboxPull | null | undefined): PlatformPostPull | null {
  if (!pull || !pull.head_sha || !inboxPullIsOpen(pull)) return null;
  return { key: pull.key, url: pull.url, number: pull.number, title: pull.title, repo: pull.repo, host: pull.host, platform: pull.platform, head_sha: pull.head_sha, mine: pull.mine };
}

export function platformRules(pull: PlatformPostPull): PlatformRules {
  const caps = getPRPlatformCapabilities({ platform: pull.platform });
  // The person's own PR: the forge refuses their approval (and on GitHub their request for changes).
  const selfAuthored = pull.mine && caps.selfReviewBlocked;
  const noun = caps.changeLabel === 'MR' ? 'merge request' : 'pull request';
  return {
    label: caps.label,
    mrLabel: caps.changeLabel,
    selfAuthored,
    requestChangesSupported: caps.requestChanges,
    selfRequestChangesBlocked: caps.selfRequestChangesBlocked,
    requestChangesUnavailableReason: !caps.requestChanges
      ? `${caps.label} has no request-changes review; this posts as a comment.`
      : selfAuthored && caps.selfRequestChangesBlocked
        ? `You can't request changes on your own ${noun} on ${caps.label}.`
        : undefined,
  };
}

export function postedWords(posted: { label: string; action: string }): string {
  if (posted.action === 'approve') return `Approved on ${posted.label}`;
  if (posted.action === 'request_changes') return `Changes requested on ${posted.label}`;
  return `Review posted on ${posted.label}`;
}
