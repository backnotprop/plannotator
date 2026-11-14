import type { InboxReviewAnchor } from '@plannotator/core/review-threads';

export function reviewAnchorWhere(anchor: InboxReviewAnchor): string {
  if (anchor.line_start === 0) return `${anchor.file}, the whole file`;
  const lines = anchor.line_start === anchor.line_end ? `line ${anchor.line_start}` : `lines ${anchor.line_start}–${anchor.line_end}`;
  return `${anchor.file} ${lines}${anchor.side === 'old' ? ', removed' : ''}`;
}

export function ReviewAnchorLine({ anchor, resolved }: { anchor: InboxReviewAnchor; resolved: boolean }) {
  return (
    <div className="ib-ranchor" data-review-anchor="">
      <div className="ib-ranchor-where">
        <span dir="auto">{reviewAnchorWhere(anchor)}</span>
        {resolved && <span className="ib-ranchor-state">· Resolved</span>}
      </div>
      {anchor.code.length > 0 && <pre className="ib-ranchor-code">{anchor.code.join('\n')}</pre>}
    </div>
  );
}
