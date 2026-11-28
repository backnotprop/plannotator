import { useState } from 'react';
import { pageServerSession } from '../api';
import { inboxUrl } from '../inboxUrl';
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

export function OpenLiveReview({ threadId, title }: { threadId: string; title: string }) {
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setState('opening');
    setError(null);
    const tab = window.open('about:blank', '_blank');
    try {
      const response = await fetch(inboxUrl(`/review-threads/${encodeURIComponent(threadId)}/open`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverSession: pageServerSession() }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'The review did not start.');
      if (tab) tab.location.href = body.url;
      else window.open(body.url, '_blank');
      setState('idle');
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'The review did not start.');
      setState('failed');
    }
  };
  return (
    <div className="ib-ranchor-open" data-open-live-review="">
      <button type="button" className="ib-ranchor-btn" disabled={state === 'opening'} onClick={() => void open()}>
        {state === 'opening' ? 'Opening the review…' : `Open the review of ${title}`}
      </button>
      {error && <span className="ib-ranchor-err">{error}</span>}
    </div>
  );
}
