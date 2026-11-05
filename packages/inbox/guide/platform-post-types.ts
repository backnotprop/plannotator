/**
 * The shapes `#platform-post` (guide/PlatformPost.tsx) takes and answers, read by the window under its strict
 * settings and by PlatformPost itself.
 */
import type { CodeAnnotation } from '@plannotator/ui/types';

/**
 * A comment as the Pull requests review keeps it. A line comment's `line`/`side` are in terms of the diff it was read on,
 * so it says which: `readHead`, the commit that diff named; `readBase`, its base; `anchorSnapshot`, a stamp of the patch.
 */
export type KeptComment = CodeAnnotation & {
  readHead?: string;
  readBase?: string;
  /** For a post: the commit whose diff its lines are in, when that is not the one posted to (GitHub takes it there). */
  postAt?: string;
  /** For a post: if `postAt` has gone, its lines still read the same on the diff on screen. */
  postHere?: boolean;
};

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
  selfRequestChangesBlocked: boolean;
  requestChangesUnavailableReason: string | undefined;
}

export interface PlatformPostProps {
  pull: PlatformPostPull;
  /** The event the decision asked for (and whether the dialog offers Comment / Request changes), or null: closed. */
  open: { action: PlatformAction; chooseEvent: boolean } | null;
  /** The person's comments in this review. */
  comments: readonly KeptComment[];
  /** Those comments as stored right now, for a host whose comments another window can change. */
  readComments?: () => readonly KeptComment[];
  /** What the comments were written on: the PR's own diff, an agent's guided review, or the whole stack. */
  anchor: 'diff' | 'guide' | 'stack';
  /** Sends one request to the Inbox's `POST /api/inbox/pulls/review`. */
  post: (request: Record<string, unknown>) => Promise<Response>;
  onClose: () => void;
  /** `posted`: the comments that went, in the words that went (a whole stack's line comments map to no PR's lines and stay). */
  onPosted: (result: { action: PlatformAction; url: string; posted: readonly CodeAnnotation[]; head: string }) => void;
  /** Comments the forge took ahead of the review's end (an older commit, a partly posted review), in the words it took. */
  onWent?: (went: readonly CodeAnnotation[]) => void;
  /** A refused post closes this dialog and the host reads the PR again, so the next opening is a new decision. */
  hostReadsAgain?: boolean;
}
