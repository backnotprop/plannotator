import type { ReactNode } from 'react';
import type { InboxPull, InboxPullLink, InboxPullStack, InboxThread } from '@plannotator/core/inbox-types';
import { usePictureItAsk } from './usePictureItAsk';
import { usePullThreadGuide } from './usePullThreadGuide';

export interface LaunchAsk {
  onPress: ((opener: HTMLElement) => void) | null;
  onTheWay: boolean;
  error: string | null;
}

export interface LaunchAsks {
  guide: LaunchAsk;
  picture: LaunchAsk;
}

const noop = () => {};

export function LaunchpadLiveAsks({
  thread,
  stack,
  pr,
  link,
  onDiff,
  onAsked,
  onThread,
  children,
}: {
  thread: InboxThread;
  stack: InboxPullStack;
  pr: InboxPull;
  link: InboxPullLink;
  onDiff: () => void;
  onAsked: () => void;
  onThread: (threadId: string) => void;
  children: (asks: LaunchAsks) => ReactNode;
}) {
  const guide = usePullThreadGuide({ pull: pr, stack, link, onDiff, onAsked }, thread, noop, true);
  const picture = usePictureItAsk({ kind: 'pull', stack, linkThreadId: link.thread_id }, thread, onAsked);
  const open = () => onThread(link.thread_id);
  return (
    <>
      {children({
        guide: { onPress: guide.onGuide ?? (guide.onTheWay ? null : open), onTheWay: guide.onTheWay, error: guide.error },
        picture: { onPress: picture.onPictureIt ?? (picture.onTheWay ? null : open), onTheWay: picture.onTheWay, error: picture.error },
      })}
    </>
  );
}
