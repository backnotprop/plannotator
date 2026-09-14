import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pause, Play } from 'lucide-react';

/**
 * One-time announcement for Plannotator's two terminal clients, Plannotator TUI
 * and Herdr Annotate. Video first: the real demo footage fills the top of the
 * panel edge to edge, and the text below it is one headline and one sentence.
 * Same shell as the other first-run announcements (portal, z-[100], hand-rolled
 * Escape + Tab wrap + focus restore), with one difference: it asks the user to
 * decide nothing, so Escape, the backdrop and the single "Got it" button all do
 * the same thing.
 *
 * LAST in each app's first-run dialog chain. The Apps gate rendering through
 * terminalToolsAnnouncementCanShow so the chain dialogs never stack; see that
 * function for why last rather than first.
 *
 * The footage is hosted on plannotator.ai like GuideIntroDialog's hero image
 * (the two demos together are ~23MB, far too much to inline the way the Edit
 * Mode recording is), so the dialog has to look right without it: the poster
 * stays up while the video buffers, and if the media cannot load at all the
 * frame keeps its place and offers the X post instead.
 */

const TUI_REPO = 'https://github.com/plannotator/plannotator-tui';
const HERDR_REPO = 'https://github.com/plannotator/herdr-annotate';

/** Where the marketing deploy publishes `apps/marketing/public/assets/`. */
const MEDIA_BASE_URL = 'https://plannotator.ai/assets';

export interface TerminalToolsDemo {
  readonly id: 'full' | 'lite';
  /** Segment label. Herdr Annotate's own naming for its two install targets. */
  readonly label: string;
  readonly mp4: string;
  readonly webm: string;
  readonly poster: string;
  /** The X post the footage was cut from. */
  readonly watchUrl: string;
  readonly description: string;
}

/** 1280x806 and 1280x808: one aspect ratio, so switching never reflows the panel. */
const DEMO_ASPECT = 1280 / 806;

/**
 * Herdr Annotate's own colors, from its repo badges (assets/install-full.svg
 * and siblings): badge purple, lavender text, periwinkle accent. They belong to
 * another product, so they live as local variables on this dialog and never
 * enter theme.css. The badge purple is the one that still reads as a purple
 * block over the dark footage; the darker hero ground (#10101f-#2c2536) would
 * vanish into the frame.
 */
const HERDR_BRAND_VARS = {
  '--announce-brand': '#312b52',
  '--announce-brand-text': '#c9c6f1',
  '--announce-brand-accent': '#B9C0FF',
} as React.CSSProperties;

export const TERMINAL_TOOLS_DEMOS: readonly TerminalToolsDemo[] = [
  {
    id: 'full',
    label: 'Full',
    mp4: `${MEDIA_BASE_URL}/tui-herdr-full-demo.mp4`,
    webm: `${MEDIA_BASE_URL}/tui-herdr-full-demo.webm`,
    poster: `${MEDIA_BASE_URL}/tui-herdr-full-poster.jpg`,
    watchUrl: 'https://x.com/plannotator/status/2093419561077154287',
    description:
      'Herdr Annotate reviewing a Markdown file with Plannotator TUI: a file tree, a selected block with its comment, and the feedback sent to the agent.',
  },
  {
    id: 'lite',
    label: 'Lite',
    mp4: `${MEDIA_BASE_URL}/tui-herdr-lite-demo.mp4`,
    webm: `${MEDIA_BASE_URL}/tui-herdr-lite-demo.webm`,
    poster: `${MEDIA_BASE_URL}/tui-herdr-lite-poster.jpg`,
    watchUrl: 'https://x.com/plannotator/status/2092757422322627008',
    description:
      'Herdr Annotate Lite: terminal text selected in an agent session, a comment written in a popover, and the notes sent back to the agent.',
  },
];

interface TerminalToolsAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** Marks the announcement seen and closes it. Also wired to Escape and the backdrop. */
  readonly onDismiss: () => void;
  /**
   * Test seam. Defaults to the media query; forcing it lets a test assert the
   * reduced-motion branch without a real `matchMedia`.
   */
  readonly reducedMotion?: boolean;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function GitHubMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function XMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z"
      />
    </svg>
  );
}

function OutboundAction({
  href,
  children,
  icon,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
  readonly icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface-0/40 px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      {icon}
      {children}
    </a>
  );
}

interface DemoPlayerProps {
  readonly demo: TerminalToolsDemo;
  readonly reducedMotion: boolean;
}

/**
 * The footage. Muted, looping, inline; autoplays unless the reader asked for
 * reduced motion, in which case the poster waits behind a play button. One
 * toggle serves both: large and centered while paused, tucked into a corner
 * while playing, so a paused frame is never mistaken for a broken one.
 */
function DemoPlayer({ demo, reducedMotion }: DemoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Optimistic: autoplay is expected, so the corner control is the initial
  // shape and the centered Play only appears once the browser has proven it
  // will not start (canplaythrough with the element still paused).
  const [playing, setPlaying] = useState(!reducedMotion);
  const [failed, setFailed] = useState(false);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // Autoplay policies can reject play(); the button simply stays put.
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
      {/* Top-left, on the footage. The posters keep only a sidebar label and a
          tab marker under this corner, so nothing that matters is covered. */}
      <span
        aria-hidden="true"
        data-terminal-tools-tag
        data-shimmer={reducedMotion ? 'off' : 'on'}
        className={`terminal-tools-announcement-tag absolute left-3.5 top-3.5 z-10 select-none rounded-md px-2 py-1 text-[11px] font-semibold uppercase leading-none tracking-[0.14em] sm:left-4 sm:top-4${
          reducedMotion ? '' : ' terminal-tools-announcement-tag--sheen'
        }`}
      >
        New · Watch:
      </span>
      <video
        ref={videoRef}
        data-terminal-tools-demo={demo.id}
        poster={demo.poster}
        muted
        playsInline
        loop
        autoPlay={!reducedMotion}
        preload="auto"
        aria-label={demo.description}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onCanPlayThrough={(event) => setPlaying(!event.currentTarget.paused)}
        onClick={toggle}
        className="absolute inset-0 h-full w-full object-cover"
      >
        <source src={demo.mp4} type="video/mp4" />
        {/* The last source is the one whose error means nothing could load. */}
        <source src={demo.webm} type="video/webm" onError={() => setFailed(true)} />
      </video>

      {failed ? (
        <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-sm">
          <a
            href={demo.watchUrl}
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
          data-terminal-tools-playback={playing ? 'pause' : 'play'}
          className={
            playing
              ? 'absolute bottom-3 left-3 grid size-9 place-items-center rounded-full border border-border/60 bg-background/70 text-foreground opacity-0 outline-none backdrop-blur-sm transition-opacity motion-reduce:transition-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary'
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

interface DemoSwitchProps {
  readonly active: TerminalToolsDemo['id'];
  readonly onChange: (id: TerminalToolsDemo['id']) => void;
}

function DemoSwitch({ active, onChange }: DemoSwitchProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TERMINAL_TOOLS_DEMOS.findIndex((demo) => demo.id === active);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = TERMINAL_TOOLS_DEMOS[
      (index + step + TERMINAL_TOOLS_DEMOS.length) % TERMINAL_TOOLS_DEMOS.length
    ];
    onChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Demo"
      className="inline-flex shrink-0 rounded-lg border border-border bg-surface-0/60 p-0.5"
    >
      {TERMINAL_TOOLS_DEMOS.map((demo) => {
        const selected = demo.id === active;
        return (
          <button
            key={demo.id}
            ref={(node) => {
              tabRefs.current[demo.id] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="terminal-tools-announcement-demo"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(demo.id)}
            onKeyDown={handleKeyDown}
            className={`min-h-8 rounded-md px-3 text-xs font-medium outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-primary ${
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {demo.label}
          </button>
        );
      })}
    </div>
  );
}

export function TerminalToolsAnnouncementDialog({
  isOpen,
  onDismiss,
  reducedMotion,
}: TerminalToolsAnnouncementDialogProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [activeDemoId, setActiveDemoId] = useState<TerminalToolsDemo['id']>('full');
  const [motionPreference] = useState(() => reducedMotion ?? prefersReducedMotion());
  const reduced = reducedMotion ?? motionPreference;
  const activeDemo =
    TERMINAL_TOOLS_DEMOS.find((demo) => demo.id === activeDemoId) ?? TERMINAL_TOOLS_DEMOS[0];

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
      // Both apps submit their decision on Mod+Enter from a window-level
      // handler. This listener is registered on the capture phase, so
      // swallowing the chord here is what stops a keystroke aimed at the
      // announcement from approving a plan or posting a review behind it.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-terminal-tools-announcement-dialog]');
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
      className="terminal-tools-announcement-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      // Dismissing from the backdrop is safe here because the dialog collects
      // no decision: there is nothing to lose by closing it the impatient way.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismissRef.current();
      }}
    >
      <div
        data-terminal-tools-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-tools-announcement-title"
        aria-describedby="terminal-tools-announcement-description"
        // Width follows the viewport height as well as its width: the footage
        // keeps its aspect ratio, so on a short window the panel narrows until
        // video plus footer fit instead of scrolling the video out of view.
        // The 12rem is the footer's height, with the wrap at narrow widths.
        style={{
          ...HERDR_BRAND_VARS,
          width: `min(1120px, 100%, calc((100dvh - 2rem - 12rem) * ${DEMO_ASPECT}))`,
        }}
        className="terminal-tools-announcement-dialog flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div
          id="terminal-tools-announcement-demo"
          role="tabpanel"
          aria-label={`${activeDemo.label} demo`}
          className="shrink-0 border-b border-border"
        >
          {/* Keyed so a switch resets playback and load-failure state with the footage. */}
          <DemoPlayer key={activeDemo.id} demo={activeDemo} reducedMotion={reduced} />
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h2
                id="terminal-tools-announcement-title"
                className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
              >
                Plannotator TUI and Herdr Annotate
              </h2>
              <p
                id="terminal-tools-announcement-description"
                className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground"
              >
                Annotate Markdown and terminal text, then send the notes to your agent.
              </p>
            </div>
            <DemoSwitch active={activeDemo.id} onChange={setActiveDemoId} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <OutboundAction href={TUI_REPO} icon={<GitHubMark className="size-4" />}>
              Star plannotator-tui
            </OutboundAction>
            <OutboundAction href={HERDR_REPO} icon={<GitHubMark className="size-4" />}>
              Star herdr-annotate
            </OutboundAction>
            <OutboundAction href={activeDemo.watchUrl} icon={<XMark className="size-3.5" />}>
              Watch on X
            </OutboundAction>
            <button
              ref={dismissRef}
              type="button"
              onClick={onDismiss}
              className="ml-auto min-h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
