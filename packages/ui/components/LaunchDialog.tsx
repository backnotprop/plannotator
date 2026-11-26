import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { LAUNCH_ART_ALT, LAUNCH_ART_WAIT_MS, LAUNCH_DIALOG_WORDS, launchArtUrl } from '../utils/launchDialogWords';

/**
 * The launch dialog (the launch switch, packages/shared/launch-switch.ts): once per computer, on plan review, code
 * review, annotate and the Inbox. Loaded only when a claim says it shows (LaunchAnnouncement.tsx), so it adds nothing
 * to a page's first paint.
 *
 * The shell of the Inbox announcement (InboxAnnouncementDialog): the shared dialog (Base UI), modal, focus trapped and
 * restored on close, focus starting on "See the launch". 720 wide (`size`, SIZES below), the full width on a phone. An art band on top
 * (16:9) edge to edge under the rounded top corners with a hairline below it, then the title, the line and two
 * buttons side by side, right-aligned (the owner's pick, c2c). No close button: "Not now", Escape and the backdrop
 * close it.
 *
 * The art keeps its 16:9 band while it loads, so nothing moves when it arrives. If it fails, or has not arrived in
 * LAUNCH_ART_WAIT_MS, the band goes and the dialog is its words alone.
 *
 * "See the launch" is a plain link from the person's click (new tab, rel noopener) and answers `opened`; "Not now",
 * Escape and the backdrop answer `dismissed`. Escape and Mod+Enter are swallowed on the capture
 * phase, as the other announcements do, so no App handler behind it acts on them. No keyboard shortcut of its own.
 */

export type LaunchDialogAnswer = 'opened' | 'dismissed';

export interface LaunchDialogProps {
  readonly campaign: string;
  /** The launch page (the switch's url, already checked by the server's parser). */
  readonly url: string;
  /** Called once, with how it ended; the host closes it. */
  readonly onAnswer: (answer: LaunchDialogAnswer) => void;
  /** `large` (the default, the owner's pick for the launch): 720 wide. `standard`: the usual announcement's 560. */
  readonly size?: LaunchDialogSize;
  /** Tests: how long the art may take. */
  readonly artWaitMs?: number;
}

type ArtState = 'loading' | 'ready' | 'gone';

export type LaunchDialogSize = 'large' | 'standard';

/**
 * The two sizes of the one shell. Large: 720 wide (art band 720×405), the title a step above the Inbox announcement's,
 * the line and buttons to match. Under the width it takes the overlay's full width (the app's usual dialog margin).
 * The width also follows the viewport's height, so on a short window the art shrinks until art and words fit, never a
 * scroll: 15rem is the words and buttons, 2rem the overlay's padding.
 */
const SIZES: Record<LaunchDialogSize, { width: string; title: string; line: string; body: string; button: string }> = {
  large: {
    width: 'min(720px, 100%, calc((var(--pn-viewport-height, 100dvh) - 2rem - 15rem) * 16 / 9))',
    title: 'text-2xl sm:text-3xl',
    line: 'mt-2 text-base sm:text-lg',
    body: 'gap-5 px-5 pb-5 pt-5 sm:gap-7 sm:px-8 sm:pb-7 sm:pt-7',
    button: 'min-h-11 text-base',
  },
  standard: {
    width: 'min(560px, 100%, calc((var(--pn-viewport-height, 100dvh) - 2rem - 12rem) * 16 / 9))',
    title: 'text-xl',
    line: 'mt-1.5',
    body: 'gap-5 px-5 pb-5 pt-5 sm:gap-6 sm:px-7 sm:pb-6 sm:pt-6',
    button: 'min-h-10 text-sm',
  },
};

function useArt(src: string | null, waitMs: number): [ArtState, () => void, () => void] {
  const [state, setState] = useState<ArtState>(src ? 'loading' : 'gone');
  useEffect(() => {
    if (state !== 'loading') return;
    const timer = setTimeout(() => setState((now) => (now === 'loading' ? 'gone' : now)), waitMs);
    return () => clearTimeout(timer);
  }, [state, waitMs]);
  return [state, () => setState((now) => (now === 'loading' ? 'ready' : now)), () => setState('gone')];
}

export function LaunchDialog({ campaign, url, onAnswer, size = 'large', artWaitMs = LAUNCH_ART_WAIT_MS }: LaunchDialogProps) {
  const look = SIZES[size];
  const openRef = useRef<HTMLAnchorElement>(null);
  const answered = useRef(false);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const answer = (how: LaunchDialogAnswer) => {
    if (answered.current) return;
    answered.current = true;
    onAnswerRef.current(how);
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const artSrc = launchArtUrl(campaign);
  const [art, artLoaded, artFailed] = useArt(artSrc, artWaitMs);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        answerRef.current('dismissed');
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answerRef.current('dismissed');
      }}
    >
      <DialogContent
        hideClose
        initialFocus={openRef}
        data-launch-dialog
        data-launch-art={art}
        backdropClassName="bg-background/80 backdrop-blur-sm motion-reduce:transition-none"
        data-launch-size={size}
        style={{ width: look.width }}
        className="max-h-full max-w-none rounded-xl bg-card text-card-foreground shadow-2xl motion-reduce:transition-none"
      >
        {artSrc && art !== 'gone' && (
          <div className="relative w-full shrink-0 overflow-hidden border-b border-border bg-muted" style={{ aspectRatio: '16 / 9' }} data-launch-art-band>
            <img
              src={artSrc}
              alt={LAUNCH_ART_ALT}
              width={1120}
              height={630}
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={artLoaded}
              onError={artFailed}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none ${art === 'ready' ? 'opacity-100' : 'opacity-0'}`}
            />
          </div>
        )}

        <div className={`flex min-h-0 flex-col overflow-y-auto ${look.body}`}>
          <div className="min-w-0">
            <DialogTitle className={`text-balance font-semibold tracking-tight ${look.title}`}>{LAUNCH_DIALOG_WORDS.title}</DialogTitle>
            <DialogDescription className={`text-pretty leading-relaxed ${look.line}`}>{LAUNCH_DIALOG_WORDS.line}</DialogDescription>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-launch-not-now
              onClick={() => answer('dismissed')}
              className={`flex-1 whitespace-nowrap rounded-lg border border-border px-4 font-medium ${look.button} text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:flex-none sm:px-5`}
            >
              {LAUNCH_DIALOG_WORDS.notNow}
            </button>
            <a
              ref={openRef}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              data-launch-open
              // Answered on the next task: a link removed from the page during its own click is not followed.
              onClick={() => {
                setTimeout(() => answer('opened'), 0);
              }}
              className={`inline-flex flex-1 items-center whitespace-nowrap justify-center gap-1.5 rounded-lg bg-primary px-5 font-medium ${look.button} text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:flex-none sm:px-6`}
            >
              {LAUNCH_DIALOG_WORDS.open}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default LaunchDialog;
