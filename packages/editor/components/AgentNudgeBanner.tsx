import React from 'react';

/**
 * The one transient banner a browser agent can show through `nudge_user`.
 * Not persisted, not exported, replaced by the next call, dismissible.
 * Rendered only while a message exists, so a session without an agent has
 * no DOM for it. Motion is opt-in through `motion-safe:` so reduced-motion
 * users see it appear without animation.
 */
export interface AgentNudgeBannerProps {
  message: string;
  onDismiss: () => void;
  /** Offered when the agent has comments in the panel and it is closed. */
  onShowComments?: () => void;
}

export const AgentNudgeBanner: React.FC<AgentNudgeBannerProps> = ({ message, onDismiss, onShowComments }) => (
  <div
    data-agent-nudge="true"
    role="status"
    aria-live="polite"
    className="pointer-events-auto fixed left-1/2 top-16 z-[70] flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
  >
    <span className="mt-0.5 inline-flex h-2 w-2 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</div>
      <p className="whitespace-pre-wrap break-words leading-snug">{message}</p>
      {onShowComments && (
        <button
          type="button"
          onClick={onShowComments}
          className="mt-1 text-xs font-medium text-primary hover:underline"
        >
          Show comments
        </button>
      )}
    </div>
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss agent message"
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
);
