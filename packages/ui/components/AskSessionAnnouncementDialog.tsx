import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Pause, Play } from 'lucide-react';
import { prefersReducedMotion, XMark } from './TerminalToolsAnnouncementDialog';
import type { AskSessionAgent } from '../utils/askSessionAnnouncement';

export const ASK_SESSION_DOCS_URL = 'https://docs.plannotator.ai/open-source/workflows/ask-this-session';

export const ASK_SESSION_WATCH_URL = 'https://x.com/plannotator/status/2106875215170899992';

const OUTBOUND_ACTION_CLASS =
  'inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface-0/40 px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card';

const MEDIA_BASE_URL = 'https://plannotator.ai/assets';

export const ASK_SESSION_DEMO = {
  mp4: `${MEDIA_BASE_URL}/ask-this-session-demo.mp4`,
  webm: `${MEDIA_BASE_URL}/ask-this-session-demo.webm`,
  poster: `${MEDIA_BASE_URL}/ask-this-session-poster.jpg`,
  description:
    'A code review opened from Claude Code: two lines are selected and asked about in Plannotator, the question arrives in the Claude Code session, and its answer streams back into the Ask AI panel. Then a comment is sent and arrives in Claude Code as a message.',
} as const;

const DEMO_ASPECT = 1280 / 800;

interface AgentCopy {
  readonly name: string;
  readonly freeLine: string;
}

const AGENT_COPY: Record<AskSessionAgent, AgentCopy> = {
  'claude-code': {
    name: 'Claude Code',
    freeLine: 'Claude Code stays free while you review, and your decision arrives as a message.',
  },
  pi: {
    name: 'Pi',
    freeLine: 'Pi stays free while you review, and your decision arrives as a message.',
  },
  opencode: {
    name: 'OpenCode',
    freeLine: 'Code review and annotate no longer hold the session, and your feedback arrives as a message.',
  },
};

interface AskSessionAnnouncementDialogProps {
  readonly isOpen: boolean;
  readonly agent: AskSessionAgent;
  readonly onDismiss: () => void;
  readonly reducedMotion?: boolean;
}

function DemoPlayer({ reducedMotion }: { readonly reducedMotion: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(!reducedMotion);
  const [failed, setFailed] = useState(false);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  return (
    <div
      className="group relative w-full overflow-hidden bg-muted"
      style={{ aspectRatio: String(DEMO_ASPECT) }}
    >
      <video
        ref={videoRef}
        data-ask-session-demo
        poster={ASK_SESSION_DEMO.poster}
        muted
        playsInline
        loop
        autoPlay={!reducedMotion}
        preload="auto"
        aria-label={ASK_SESSION_DEMO.description}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onCanPlayThrough={(event) => setPlaying(!event.currentTarget.paused)}
        onClick={toggle}
        className="absolute inset-0 h-full w-full object-cover"
      >
        <source src={ASK_SESSION_DEMO.mp4} type="video/mp4" />
        <source src={ASK_SESSION_DEMO.webm} type="video/webm" onError={() => setFailed(true)} />
      </video>

      {failed ? (
        <div
          data-ask-session-demo-unavailable
          className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-sm"
        >
          <a
            href={ASK_SESSION_WATCH_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground outline-none hover:bg-surface-1 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <XMark className="size-3.5" />
            Watch on X
          </a>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause demo' : 'Play demo'}
          data-ask-session-playback={playing ? 'pause' : 'play'}
          className={
            playing
              ? 'absolute bottom-3 left-3 grid size-9 place-items-center rounded-full border border-border/60 bg-background/70 text-foreground opacity-0 outline-none backdrop-blur-sm transition-opacity motion-reduce:transition-none group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:ring-2 focus-visible:ring-primary'
              : 'absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border/60 bg-background/80 text-foreground shadow-lg outline-none backdrop-blur-sm transition-transform motion-reduce:transition-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary'
          }
        >
          {playing ? (
            <Pause className="size-4" aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 size-6 fill-current" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

export function AskSessionAnnouncementDialog({
  isOpen,
  agent,
  onDismiss,
  reducedMotion,
}: AskSessionAnnouncementDialogProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [motionPreference] = useState(() => reducedMotion ?? prefersReducedMotion());
  const reduced = reducedMotion ?? motionPreference;
  const copy = AGENT_COPY[agent];

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dismissRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-ask-session-announcement-dialog]');
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
          ?? [],
      ).filter((element) => element.getAttribute('tabindex') !== '-1');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismissRef.current();
      }}
    >
      <div
        data-ask-session-announcement-dialog
        data-ask-session-agent={agent}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-session-announcement-title"
        aria-describedby="ask-session-announcement-description"
        style={{ width: `min(1120px, 100%, calc((100dvh - 2rem - 12rem) * ${DEMO_ASPECT}))` }}
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="shrink-0 border-b border-border">
          <DemoPlayer reducedMotion={reduced} />
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <h2
            id="ask-session-announcement-title"
            className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
          >
            Ask {copy.name}, right from Plannotator
          </h2>
          <p
            id="ask-session-announcement-description"
            className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground"
          >
            Ask AI now goes to the {copy.name} session that opened Plannotator, and the answer
            streams back here. {copy.freeLine}
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <p
              data-ask-session-status="connected"
              className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground"
            >
              <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
              This session is connected. Open Ask AI to try it.
            </p>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <a
                href={ASK_SESSION_WATCH_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-ask-session-watch
                className={OUTBOUND_ACTION_CLASS}
              >
                <XMark className="size-3.5" />
                Watch on X
              </a>
              <a
                href={ASK_SESSION_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-ask-session-learn-more
                className={OUTBOUND_ACTION_CLASS}
              >
                Learn more
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
              <button
                ref={dismissRef}
                type="button"
                onClick={onDismiss}
                className="min-h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
