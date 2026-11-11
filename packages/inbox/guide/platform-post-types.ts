import type { CodeAnnotation } from '@plannotator/ui/types';

export type KeptComment = CodeAnnotation & {
  readHead?: string;
  readBase?: string;
  postAt?: string;
  postHere?: boolean;
  onPullDiff?: boolean;
};

export type PlatformAction = 'approve' | 'comment' | 'request_changes';

export interface PlatformPostPull {
  key: string;
  url: string;
  number: number;
  title: string;
  repo: string;
  host: string;
  platform: 'github' | 'gitlab';
  head_sha: string;
  mine: boolean;
}

export interface PlatformRules {
  label: string;
  mrLabel: string;
  selfAuthored: boolean;
  requestChangesSupported: boolean;
  selfRequestChangesBlocked: boolean;
  requestChangesUnavailableReason: string | undefined;
}

export interface PlatformPostProps {
  pull: PlatformPostPull;
  open: { action: PlatformAction; chooseEvent: boolean } | null;
  comments: readonly KeptComment[];
  readComments?: () => readonly KeptComment[];
  anchor: 'diff' | 'guide' | 'stack';
  post: (request: Record<string, unknown>) => Promise<Response>;
  onClose: () => void;
  onPosted: (result: { action: PlatformAction; url: string; posted: readonly CodeAnnotation[]; head: string }) => void;
  onWent?: (went: readonly CodeAnnotation[]) => void;
  hostReadsAgain?: boolean;
}
