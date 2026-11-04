/**
 * The shapes `#platform-post` (guide/PlatformPost.tsx) takes and answers, read by the window under its strict
 * settings and by PlatformPost itself.
 */
import type { CodeAnnotation } from '@plannotator/ui/types';

/** A review event as the forge takes it (the review app's `PRReviewAction`). */
export type PlatformAction = 'approve' | 'comment' | 'request_changes';

/** The PR a review is posted to: the list's PR, pinned to the head commit the person read. */
export interface PlatformPostPull {
  key: string;
  url: string;
  number: number;
  title: string;
  /** `owner/repo` (GitHub) or the project's full path (GitLab). */
  repo: string;
  host: string;
  platform: 'github' | 'gitlab';
  head_sha: string;
  /** The person's own PR: the forge refuses their approval (and on GitHub their request for changes). */
  mine: boolean;
}

export interface PlatformRules {
  /** "GitHub" or "GitLab". */
  label: string;
  /** "PR" or "MR". */
  mrLabel: string;
  selfAuthored: boolean;
  requestChangesSupported: boolean;
  requestChangesUnavailableReason: string | undefined;
}

export interface PlatformPostProps {
  pull: PlatformPostPull;
  /** The event the decision asked for (and whether the dialog offers Comment / Request changes), or null: closed. */
  open: { action: PlatformAction; chooseEvent: boolean } | null;
  /** The person's comments in this review. */
  comments: readonly CodeAnnotation[];
  /** What the comments were written on: the PR's own diff, an agent's guided review, or the whole stack. */
  anchor: 'diff' | 'guide' | 'stack';
  /** Sends one request to the Inbox's `POST /api/inbox/pulls/review`. */
  post: (request: Record<string, unknown>) => Promise<Response>;
  onClose: () => void;
  onPosted: (result: { action: PlatformAction; url: string }) => void;
}
