import type { InboxPullChecks } from '@plannotator/core/inbox-types';

export function checksLabel(checks: InboxPullChecks | null): string | null {
  return checks === 'success' ? 'checks passed' : checks === 'failure' ? 'checks failing' : checks === 'pending' ? 'checks running' : null;
}

export function ChecksMark({ checks }: { checks: InboxPullChecks | null }) {
  if (checks === 'success') {
    return (
      <svg className="ib-prck" data-checks="success" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2.5 6.3 4.9 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (checks === 'pending') {
    return (
      <svg className="ib-prck" data-checks="pending" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M6 1.75A4.25 4.25 0 1 1 1.75 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (checks === 'failure') {
    return (
      <svg className="ib-prck" data-checks="failure" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <circle cx="6" cy="6" r="6" fill="var(--destructive)" />
        <path d="M4 4l4 4M8 4 4 8" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}
