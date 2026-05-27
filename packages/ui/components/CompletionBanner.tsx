interface CompletionBannerProps {
  submitted: 'approved' | 'denied' | 'feedback' | 'exited' | 'awaiting' | 'feedback-sent' | null | false;
  title: string;
  subtitle: string;
  onCancel?: () => void;
}

export function CompletionBanner({ submitted, title, subtitle, onCancel }: CompletionBannerProps) {
  if (!submitted) return null;

  const isApproved = submitted === 'approved';
  const isAwaiting = submitted === 'awaiting';
  const isFeedbackSent = submitted === 'feedback-sent';

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 border-b flex-shrink-0 ${
        isAwaiting
          ? 'bg-warning/10 border-warning/20 text-warning'
          : isApproved || isFeedbackSent
            ? 'bg-success/10 border-success/20 text-success'
            : 'bg-accent/10 border-accent/20 text-accent'
      }`}
    >
      {isAwaiting ? (
        <svg className="w-4 h-4 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ) : (
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          {isApproved || isFeedbackSent ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          )}
        </svg>
      )}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground truncate">{subtitle}</span>
      </div>
      {isAwaiting && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 py-1 rounded border border-current/20 hover:bg-current/10 flex-shrink-0"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
