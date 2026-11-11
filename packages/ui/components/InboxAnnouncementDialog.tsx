import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Play } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

/**
 * Built on the shared dialog (`./ui/dialog`, Base UI): modal, focus trapped, focus restored on
 * close, the backdrop and Escape close it.
 */

export const INBOX_PAGE_URL = 'https://plannotator.ai/inbox';

const MEDIA_BASE_URL = 'https://plannotator.ai/assets';

export const INBOX_FILM = {
  mp4: `${MEDIA_BASE_URL}/inbox-film.mp4`,
  poster: `${MEDIA_BASE_URL}/inbox-film-poster.jpg`,
} as const;

const FILM_ASPECT = 16 / 9;

const PANEL_WIDTH =
  `min(1200px, 100%, calc((var(--pn-viewport-height, 100dvh) - 2rem - 10rem) * ${FILM_ASPECT}))`;

interface InboxAnnouncementDialogProps {
  readonly isOpen: boolean;
  readonly onDismiss: () => void;
}

function Film() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  const play = () => {
    setStarted(true);
    void videoRef.current?.play()?.catch(() => {});
  };

  return (
    <div className="relative w-full shrink-0 overflow-hidden border-b border-border bg-muted" style={{ aspectRatio: String(FILM_ASPECT) }}>
      <video
        ref={videoRef}
        data-inbox-film
        poster={INBOX_FILM.poster}
        controls={started}
        playsInline
        preload="none"
        aria-label="The Plannotator Inbox film"
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full bg-muted object-contain"
      >
        <source src={INBOX_FILM.mp4} type="video/mp4" onError={() => setFailed(true)} />
      </video>

      {failed ? (
        <p
          data-inbox-film-unavailable
          className="absolute inset-0 grid place-items-center bg-background/75 px-6 text-center text-sm text-muted-foreground backdrop-blur-sm"
        >
          The film could not load. It is also on the Inbox page.
        </p>
      ) : !started ? (
        <button
          type="button"
          onClick={play}
          aria-label="Play the Inbox film"
          data-inbox-film-play
          className="group absolute inset-0 grid place-items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        >
          <span className="grid size-16 place-items-center rounded-full border border-border/60 bg-background/80 text-foreground shadow-lg backdrop-blur-sm transition-transform motion-reduce:transition-none group-hover:scale-105 sm:size-20">
            <Play className="ml-1 size-6 fill-current sm:size-7" aria-hidden="true" />
          </span>
        </button>
      ) : null}
    </div>
  );
}

export function InboxAnnouncementDialog({ isOpen, onDismiss }: InboxAnnouncementDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape is handled here rather than by the dialog so that no window
      // handler of the App behind it (close a panel, leave a mode) sees it.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      // Both apps submit their decision on Mod+Enter from a window-level
      // handler; swallow it on the capture phase.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismissRef.current();
      }}
    >
      <DialogContent
        hideClose
        initialFocus={closeRef}
        data-inbox-announcement-dialog
        backdropClassName="bg-background/90 backdrop-blur-sm"
        style={{ width: PANEL_WIDTH }}
        className="max-h-full max-w-none rounded-xl bg-card text-card-foreground shadow-2xl motion-reduce:transition-none"
      >
        <Film />

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:gap-8 sm:px-7 sm:py-6">
          <div className="min-w-0">
            <DialogTitle className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
              The Plannotator Inbox
            </DialogTitle>
            <DialogDescription className="mt-1.5 max-w-xl text-pretty leading-relaxed">
              Questions, blockers and reviews from your agents arrive in one inbox while they work,
              and your answers go back to them.
            </DialogDescription>
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              ref={closeRef}
              type="button"
              data-inbox-announcement-close
              onClick={() => onDismissRef.current()}
              className="min-h-10 rounded-lg border border-border px-4 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Close
            </button>
            <a
              href={INBOX_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-inbox-announcement-learn-more
              onClick={() => {
                setTimeout(() => onDismissRef.current(), 0);
              }}
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Learn about the Inbox
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
