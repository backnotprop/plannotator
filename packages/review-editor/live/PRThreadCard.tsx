import type { PRReviewThread } from '@plannotator/shared/pr-types';

export function prThreadPlace(thread: PRReviewThread): { line: number; side: 'old' | 'new' } | null {
  const line = thread.line ?? thread.startLine;
  if (!line) return null;
  return { line, side: thread.diffSide === 'LEFT' ? 'old' : 'new' };
}

export function PRThreadCard({ thread, forge }: { thread: PRReviewThread; forge: string }) {
  const shown = thread.comments.filter((c) => !c.isMinimized);
  const first = thread.comments[0];
  return (
    <div className="live-thread mx-2 my-1 rounded border border-border bg-card" data-pr-thread={thread.id}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
        <span>On the {forge === 'GitLab' ? 'merge request' : 'pull request'}</span>
        {thread.isResolved ? <span>· Resolved</span> : null}
        {thread.isOutdated ? <span>· Outdated</span> : null}
        <span className="flex-1" />
        {first ? (
          <a href={first.url} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
            Reply on {forge}
          </a>
        ) : null}
      </div>
      <div className="divide-y divide-border">
        {shown.map((comment) => (
          <div key={comment.id} className="flex flex-col gap-0.5 px-3 py-2">
            <div className="flex items-baseline gap-1.5 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{comment.author}</span>
              <span>{new Date(comment.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">{comment.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
